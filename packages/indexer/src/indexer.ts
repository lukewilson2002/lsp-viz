/**
 * createIndexer orchestration: workspace discovery → file walk → structural
 * phase (tree-sitter) → semantic phase (LSP) → aggregate materialization,
 * with full and mtime-diff modes, progress events, and cancellation.
 *
 * The semantic phase takes TWO file lists, not one, because its two sweeps
 * answer different questions. `files` is "whose symbols and calls need
 * (re-)crawling" — the mtime-diff set. `referenceFiles` is "whose declarations
 * need a find-all-references pass", and on a diff run that is a strictly larger
 * set: every file is asked about ITS OWN declarations, but the edge that comes
 * back belongs to the file doing the referring (see {@link importClosure}).
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import type { IndexStats } from '@lsp-viz/core';
import { typescriptAdapter } from './adapters/typescript.js';
import { runSemanticPhase } from './semantic.js';
import { fileNodeId, runStructuralPhase } from './structural.js';
import type {
  Indexer,
  IndexerOptions,
  IndexMode,
  IndexProgressEvent,
  LanguageAdapter,
} from './types.js';
import { walkFiles } from './walk.js';
import { discoverPackages } from './workspace.js';

const DEFAULT_CONCURRENCY = 16;

/**
 * The changed files plus everything they (transitively) import.
 *
 * A `references` edge is produced while crawling the REFERENT's file but owned
 * — `sourcePath` — by the REFERRER's. When a referrer changes, its edges are
 * deleted with the rest of its file data while the referent is untouched and
 * would never be re-swept. Only the referrer's import closure can recreate
 * them, and `getCalls` on a file node returns exactly its import links.
 */
function importClosure(store: IndexerOptions['store'], seeds: readonly string[]): string[] {
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const link of store.getCalls(fileNodeId(file)).outgoing) {
      if (link.edge.kind !== 'imports' || link.node.kind !== 'file') continue;
      if (seen.has(link.node.path)) continue;
      seen.add(link.node.path);
      queue.push(link.node.path);
    }
  }
  return [...seen];
}

/** Map each extension to the first adapter that claims it. */
function adapterByExtension(adapters: readonly LanguageAdapter[]): Map<string, LanguageAdapter> {
  const map = new Map<string, LanguageAdapter>();
  for (const adapter of adapters) {
    for (const ext of adapter.extensions) {
      if (!map.has(ext)) map.set(ext, adapter);
    }
  }
  return map;
}

export function createIndexer(opts: IndexerOptions): Indexer {
  const repoRoot = path.resolve(opts.repoRoot);
  const store = opts.store;
  const adapters = opts.adapters ?? [typescriptAdapter];
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  let running = false;
  let cancelled = false;
  let current: Promise<IndexStats> | null = null;

  const emit = (event: IndexProgressEvent): void => {
    opts.onProgress?.(event);
  };

  async function doRun(mode: IndexMode): Promise<IndexStats> {
    const t0 = Date.now();
    const extMap = adapterByExtension(adapters);
    const packages = discoverPackages(repoRoot);
    const allFilesList = walkFiles(repoRoot, [...extMap.keys()]);
    const allFiles = new Set(allFilesList);

    // Workspace restructuring (new/removed packages, moved entry points)
    // invalidates the containment tree in ways per-file diffing cannot see.
    const fingerprint = JSON.stringify(
      packages.map((p) => ({ n: p.name, d: p.dir, e: p.entryPaths })),
    );
    let effectiveMode = mode;
    if (mode === 'diff' && store.getMeta('workspaceFingerprint') !== fingerprint) {
      console.log('[indexer] workspace structure changed; escalating diff to full re-index');
      effectiveMode = 'full';
    }

    // ---- decide per-file work (full vs diff) ------------------------------
    let structuralTargets: string[];
    if (effectiveMode === 'full') {
      store.clearAll();
      structuralTargets = allFilesList;
    } else {
      structuralTargets = [];
      const records = new Map(store.listFileRecords().map((r) => [r.path, r]));
      for (const file of allFilesList) {
        const record = records.get(file);
        let changed = record === undefined || !record.structuralDone;
        if (!changed && record) {
          try {
            const stat = statSync(path.join(repoRoot, file));
            changed = Math.floor(stat.mtimeMs) !== record.mtimeMs || stat.size !== record.size;
          } catch {
            changed = true;
          }
        }
        if (changed) structuralTargets.push(file);
      }
      // Files present in the store but gone from disk (or newly ignored).
      const removed = [...records.keys()].filter((p) => !allFiles.has(p));
      store.deleteFilesData(removed);
      store.deleteFilesData(structuralTargets);
    }

    // ---- structural phase -------------------------------------------------
    const tStructural = Date.now();
    emit({ type: 'phase', phase: 'structural' });
    let structuralDone = 0;
    for (const adapter of adapters) {
      if (cancelled) break;
      const files = structuralTargets.filter((f) => extMap.get(path.posix.extname(f)) === adapter);
      if (files.length === 0) continue;
      const { filesProcessed } = await runStructuralPhase({
        repoRoot,
        store,
        adapter,
        packages,
        files,
        allFiles,
        filesTotal: structuralTargets.length,
        filesDoneBase: structuralDone,
        emit,
        isCancelled: () => cancelled,
      });
      structuralDone += filesProcessed;
    }
    const structuralMs = Date.now() - tStructural;

    // ---- semantic phase (files whose semantic layer is stale) -------------
    const tSemantic = Date.now();
    let symbols = 0;
    let callEdges = 0;
    let refEdges = 0;
    if (!cancelled) {
      emit({ type: 'phase', phase: 'semantic' });
      // Computed AFTER the structural phase so the changed files' import edges
      // are already rebuilt. Reference sweep only — pulling these back into the
      // symbol/call sweep would double every call weight (addEdge accumulates).
      const referenceTargets =
        effectiveMode === 'full' ? allFilesList : importClosure(store, structuralTargets);
      const pending = new Set(
        store
          .listFileRecords()
          .filter((r) => !r.semanticDone)
          .map((r) => r.path),
      );
      for (const adapter of adapters) {
        if (cancelled) break;
        const files = allFilesList.filter(
          (f) => pending.has(f) && extMap.get(path.posix.extname(f)) === adapter,
        );
        const referenceFiles = referenceTargets.filter(
          (f) => extMap.get(path.posix.extname(f)) === adapter,
        );
        if (files.length === 0 && referenceFiles.length === 0) continue;
        const result = await runSemanticPhase({
          repoRoot,
          store,
          adapter,
          files,
          referenceFiles,
          concurrency,
          emit,
          isCancelled: () => cancelled,
        });
        symbols += result.symbols;
        callEdges += result.callEdges;
        refEdges += result.refEdges;
      }
    }
    const semanticMs = Date.now() - tSemantic;

    // ---- aggregate + meta -------------------------------------------------
    const tAggregate = Date.now();
    emit({ type: 'phase', phase: 'aggregate' });
    // Diff runs only delete file/symbol nodes; sweep containers that ended up
    // empty (vanished directories) so they stop rendering as ghost views.
    store.gcEmptyContainers();
    // Symbols removed from re-crawled files may leave callers' edges dangling.
    // Only safe after a COMPLETE run — mid-cancel, targets may simply not have
    // been re-crawled yet and their edges become valid again on resume.
    if (!cancelled) store.pruneDanglingEdges();
    store.materializeAggregates();
    store.setMeta('repoRoot', repoRoot);
    store.setMeta('workspaceFingerprint', fingerprint);
    if (!cancelled) store.setMeta('indexedAt', new Date().toISOString());
    const aggregateMs = Date.now() - tAggregate;

    const storeStats = store.stats();
    const stats: IndexStats = {
      files: storeStats.files,
      nodes: storeStats.nodes,
      edges: storeStats.edges,
      durationMs: Date.now() - t0,
    };
    emit({ type: 'done', stats });
    console.log(
      `[indexer] ${effectiveMode}${cancelled ? ' (cancelled)' : ''}: ${stats.files} files, ` +
        `${stats.nodes} nodes, ${stats.edges} edges, ${symbols} symbols, ${callEdges} call edges, ` +
        `${refEdges} reference edges ` +
        `(structural ${structuralMs}ms, semantic ${semanticMs}ms, aggregate ${aggregateMs}ms, ` +
        `total ${stats.durationMs}ms)`,
    );
    return stats;
  }

  return {
    async run(mode: IndexMode): Promise<IndexStats> {
      if (running) throw new Error('indexer is already running');
      running = true;
      cancelled = false;
      const promise = (async () => {
        try {
          return await doRun(mode);
        } catch (error) {
          emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          running = false;
        }
      })();
      current = promise;
      return promise;
    },

    async cancel(): Promise<void> {
      cancelled = true;
      if (current) {
        try {
          await current;
        } catch {
          // run() already surfaced the failure; cancel just waits it out.
        }
      }
    },

    get running(): boolean {
      return running;
    },
  };
}
