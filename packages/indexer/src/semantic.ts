/**
 * Semantic phase: LSP-driven symbol + call-graph extraction.
 *
 * Per file: didOpen → documentSymbol → symbol GraphNodes (deterministic ids),
 * then hover (signatures) and call hierarchy (calls edges) pipelined through a
 * bounded promise pool → didClose. Call targets in files not yet processed go
 * to a pending list retried once after all files complete. The phase survives
 * language-server crashes: a dead child is restarted and the file retried
 * (max 2 attempts per file).
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSymbolKind, nodeId } from '@lsp-viz/core';
import type { GraphNode, GraphStore, NodeKind, Position, Range } from '@lsp-viz/core';
import { DocumentSymbol } from 'vscode-languageserver-protocol';
import type {
  DocumentSymbol as LspDocumentSymbol,
  Hover,
  SymbolInformation,
} from 'vscode-languageserver-protocol';
import { LspClient, LspDeadError, delay, uriToRepoRelative } from './lsp/client.js';
import { fileNodeId } from './structural.js';
import type { IndexProgressEvent, LanguageAdapter } from './types.js';

export interface SemanticContext {
  repoRoot: string;
  store: GraphStore;
  adapter: LanguageAdapter;
  /** Files (repo-relative, posix) still needing semantic analysis. */
  files: string[];
  /** Max in-flight LSP requests. */
  concurrency: number;
  emit: (e: IndexProgressEvent) => void;
  isCancelled: () => boolean;
}

/** Test-only lifecycle hooks (crash-recovery tests observe/kill the child). */
export interface SemanticTestHooks {
  /** Called after each file finishes (success or give-up), with the live client. */
  onFileDone?: (file: string, client: LspClient) => void;
}
export const semanticTestHooks: SemanticTestHooks = {};

const HOVER_KINDS: readonly NodeKind[] = ['function', 'method', 'class'];
const CALL_KINDS: readonly NodeKind[] = ['function', 'method'];
const SIGNATURE_MAX_LENGTH = 500;
const MAX_ATTEMPTS_PER_FILE = 2;
const WARMUP_RETRIES = 10;
const WARMUP_DELAY_MS = 250;

interface SymbolEntry {
  node: GraphNode;
  needsHover: boolean;
  needsCalls: boolean;
}

interface PendingCall {
  fromId: string;
  toPath: string;
  selStart: Position;
  count: number;
  /** File whose analysis produced the edge (the from-symbol's file). */
  sourcePath: string;
}

/** Strip markdown fences/decoration from hover contents → first meaningful plain-text chunk. */
export function extractSignature(hover: Hover | null): string | undefined {
  if (!hover) return undefined;
  const parts: string[] = [];
  const push = (value: string): void => {
    if (value.trim().length > 0) parts.push(value);
  };
  const contents = hover.contents;
  if (Array.isArray(contents)) {
    for (const entry of contents) push(typeof entry === 'string' ? entry : entry.value);
  } else if (typeof contents === 'string') {
    push(contents);
  } else {
    push(contents.value);
  }
  if (parts.length === 0) return undefined;
  const withoutFences = parts
    .join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('```'))
    .join('\n');
  const chunk = withoutFences
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .find((c) => c.length > 0);
  if (!chunk) return undefined;
  const cleaned = chunk.replace(/\r/g, '').trim();
  return cleaned.length > SIGNATURE_MAX_LENGTH ? cleaned.slice(0, SIGNATURE_MAX_LENGTH) : cleaned;
}

function lineSpan(range: Range): number {
  return range.end.line - range.start.line + 1;
}

/**
 * Deterministic id for the n-th occurrence of a (kind, name, container)
 * triple within one file. Same-named siblings are common (tsserver labels
 * every inline callback of a call site "x() callback"), and dropping the
 * later ones would silently lose their nodes and every call they make.
 * Document order is stable for unchanged code, so ids stay deterministic.
 */
function occurrenceId(
  seen: Map<string, number>,
  filePath: string,
  kind: string,
  name: string,
  containerName: string | null,
): string {
  const base = nodeId(filePath, kind, name, containerName);
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : nodeId(filePath, kind, name, `${containerName ?? ''}#${n}`);
}

/**
 * Map a hierarchical DocumentSymbol tree to graph nodes. A symbol whose LSP
 * kind maps to null is skipped along with its entire subtree.
 */
function collectDocumentSymbols(
  symbols: readonly LspDocumentSymbol[],
  filePath: string,
  parentId: string,
  containerName: string | null,
  adapter: LanguageAdapter,
  out: SymbolEntry[],
  byId: Map<string, SymbolEntry>,
  seen: Map<string, number>,
): void {
  for (const symbol of symbols) {
    const kind = adapter.mapSymbolKind(symbol.kind);
    if (kind === null) continue; // skip the node AND its children
    const name = symbol.name;
    const id = occurrenceId(seen, filePath, kind, name, containerName);
    const node: GraphNode = {
      id,
      kind,
      name,
      path: filePath,
      parentId,
      language: adapter.id,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      attrs: { loc: lineSpan(symbol.range) },
    };
    if (symbol.detail !== undefined && symbol.detail !== '') node.detail = symbol.detail;
    const entry: SymbolEntry = {
      node,
      needsHover: HOVER_KINDS.includes(kind),
      needsCalls: CALL_KINDS.includes(kind),
    };
    byId.set(id, entry);
    out.push(entry);
    if (symbol.children && symbol.children.length > 0) {
      collectDocumentSymbols(symbol.children, filePath, id, name, adapter, out, byId, seen);
    }
  }
}

/** Flat SymbolInformation fallback (servers ignoring hierarchical support). */
function collectFlatSymbols(
  symbols: readonly SymbolInformation[],
  filePath: string,
  fileNodeId: string,
  adapter: LanguageAdapter,
  out: SymbolEntry[],
  byId: Map<string, SymbolEntry>,
  seen: Map<string, number>,
): void {
  for (const symbol of symbols) {
    const kind = adapter.mapSymbolKind(symbol.kind);
    if (kind === null) continue;
    const containerName = symbol.containerName ? symbol.containerName : null;
    const id = occurrenceId(seen, filePath, kind, symbol.name, containerName);
    const entry: SymbolEntry = {
      node: {
        id,
        kind,
        name: symbol.name,
        path: filePath,
        parentId: fileNodeId,
        language: adapter.id,
        range: symbol.location.range,
        selectionRange: symbol.location.range,
        attrs: { loc: lineSpan(symbol.location.range) },
      },
      needsHover: HOVER_KINDS.includes(kind),
      needsCalls: CALL_KINDS.includes(kind),
    };
    byId.set(id, entry);
    out.push(entry);
  }
}

function positionsEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

function rangeContains(range: Range, pos: Position): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 100000 + (range.end.character - range.start.character);
}

/**
 * Resolve a call target position to a symbol node id among `nodes`:
 * exact selectionRange.start match first, else the smallest containing range.
 */
function resolveAmongNodes(nodes: readonly GraphNode[], selStart: Position): string | null {
  for (const node of nodes) {
    if (!isSymbolKind(node.kind)) continue;
    if (node.selectionRange && positionsEqual(node.selectionRange.start, selStart)) return node.id;
  }
  let best: GraphNode | null = null;
  for (const node of nodes) {
    if (!isSymbolKind(node.kind)) continue;
    if (!node.range || !rangeContains(node.range, selStart)) continue;
    if (best === null || rangeSize(node.range) < rangeSize(best.range as Range)) best = node;
  }
  return best?.id ?? null;
}

/** Bounded promise pool; the first worker error aborts scheduling and rethrows. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  let firstError: unknown;
  let failed = false;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: lanes }, async () => {
    for (;;) {
      if (failed) return;
      const i = index;
      index += 1;
      if (i >= items.length) return;
      try {
        await worker(items[i] as T);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw firstError;
}

export async function runSemanticPhase(
  ctx: SemanticContext,
): Promise<{ symbols: number; callEdges: number }> {
  const { repoRoot, store, adapter, files, concurrency, emit, isCancelled } = ctx;
  let totalSymbols = 0;
  let totalCallEdges = 0;

  // Retry every persisted unresolved call target (this run's and leftovers
  // from interrupted earlier runs). Pure DB work — needs no language server.
  const resolveStoredPendings = (): void => {
    const resolvedIds: number[] = [];
    const byToPath = new Map<string, ReturnType<typeof store.listPendingCalls>>();
    for (const p of store.listPendingCalls()) {
      const group = byToPath.get(p.toPath);
      if (group) group.push(p);
      else byToPath.set(p.toPath, [p]);
    }
    for (const [toPath, rows] of byToPath) {
      const candidates = store.getNodesByPath(toPath).filter((n) => n.kind !== 'file');
      for (const p of rows) {
        const toId = resolveAmongNodes(candidates, { line: p.selLine, character: p.selChar });
        if (toId === null) continue; // still unresolved: keep for a later run
        store.addEdge('calls', p.fromId, toId, p.count, p.sourcePath);
        totalCallEdges += 1;
        resolvedIds.push(p.id);
      }
    }
    if (resolvedIds.length > 0) store.deletePendingCalls(resolvedIds);
  };

  if (files.length === 0) {
    resolveStoredPendings();
    return { symbols: 0, callEdges: totalCallEdges };
  }

  const client = new LspClient(adapter, repoRoot, {
    onExit: (info) => {
      if (!info.expected) {
        console.warn(
          `[indexer] semantic: ${adapter.id} language server exited unexpectedly ` +
            `(code ${String(info.code)}, signal ${String(info.signal)}, generation ${info.generation})`,
        );
      }
    },
  });
  try {
    await client.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[indexer] semantic: failed to start ${adapter.id} language server: ${message}`);
    await client.dispose();
    return { symbols: 0, callEdges: 0 };
  }

  const filesTotal = files.length;
  let filesDone = 0;
  /** First file on a fresh server retries empty results while it warms up. */
  let warmedUp = false;
  /** Set when the server cannot even be restarted — abort the phase. */
  let brokenBeyondRepair = false;

  /** Process one file end-to-end. All store writes happen only on success. */
  const processFile = async (file: string): Promise<{ symbols: number; callEdges: number }> => {
    const absPath = path.join(repoRoot, file);
    const text = readFileSync(absPath, 'utf8');
    await client.openDocument(file, text);
    try {
      let response = await client.documentSymbols(file);
      if (!warmedUp) {
        for (
          let attempt = 0;
          (response === null || response.length === 0) && attempt < WARMUP_RETRIES && !isCancelled();
          attempt += 1
        ) {
          await delay(WARMUP_DELAY_MS);
          response = await client.documentSymbols(file);
        }
      }

      const fileId = fileNodeId(file);
      const entries: SymbolEntry[] = [];
      const byId = new Map<string, SymbolEntry>();
      const seenIds = new Map<string, number>();
      if (response !== null && response.length > 0) {
        const first = response[0];
        if (DocumentSymbol.is(first)) {
          collectDocumentSymbols(
            response as LspDocumentSymbol[],
            file,
            fileId,
            null,
            adapter,
            entries,
            byId,
            seenIds,
          );
        } else {
          collectFlatSymbols(
            response as SymbolInformation[],
            file,
            fileId,
            adapter,
            entries,
            byId,
            seenIds,
          );
        }
      }

      // First file with symbols: wait until hover answers (tsserver warm-up),
      // so early signatures are not silently dropped.
      const firstHoverable = entries.find((e) => e.needsHover && e.node.selectionRange);
      if (!warmedUp && firstHoverable) {
        for (let attempt = 0; attempt < WARMUP_RETRIES && !isCancelled(); attempt += 1) {
          const probe = await client.hover(file, (firstHoverable.node.selectionRange as Range).start);
          if (probe !== null) break;
          await delay(WARMUP_DELAY_MS);
        }
        warmedUp = true;
      }

      const localNodes = entries.map((e) => e.node);
      const fileEdges = new Map<string, { fromId: string; toId: string; count: number }>();
      const filePending: PendingCall[] = [];

      // Several call sites often target the same file; fetch its nodes once.
      const targetNodesCache = new Map<string, GraphNode[]>();
      const targetNodes = (toPath: string): GraphNode[] => {
        let nodes = targetNodesCache.get(toPath);
        if (nodes === undefined) {
          nodes = store.getNodesByPath(toPath).filter((n) => n.kind !== 'file');
          targetNodesCache.set(toPath, nodes);
        }
        return nodes;
      };
      const resolveTarget = (toPath: string, selStart: Position): string | null => {
        if (toPath === file) return resolveAmongNodes(localNodes, selStart);
        return resolveAmongNodes(targetNodes(toPath), selStart);
      };

      /** Swallow per-request server errors; only a dead process aborts the file. */
      const guarded = async <T>(fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn();
        } catch (error) {
          if (error instanceof LspDeadError) throw error;
          return null;
        }
      };

      const tasks = entries.filter((e) => e.needsHover || e.needsCalls);
      await runPool(tasks, concurrency, async (entry) => {
        const sel = entry.node.selectionRange;
        if (!sel) return;
        if (entry.needsHover) {
          const hover = await guarded(() => client.hover(file, sel.start));
          const signature = extractSignature(hover);
          if (signature !== undefined) entry.node.signature = signature;
        }
        if (!entry.needsCalls) return;
        const items = await guarded(() => client.prepareCallHierarchy(file, sel.start));
        for (const item of items ?? []) {
          const outgoing = await guarded(() => client.outgoingCalls(item));
          for (const call of outgoing ?? []) {
            const toPath = uriToRepoRelative(call.to.uri, repoRoot);
            if (toPath === null) continue; // target outside the repo
            const selStart: Position = {
              line: call.to.selectionRange.start.line,
              character: call.to.selectionRange.start.character,
            };
            const count = Math.max(1, call.fromRanges.length); // 1 per call site
            const toId = resolveTarget(toPath, selStart);
            if (toId !== null) {
              const key = `${entry.node.id} ${toId}`;
              const existing = fileEdges.get(key);
              if (existing) existing.count += count;
              else fileEdges.set(key, { fromId: entry.node.id, toId, count });
            } else {
              filePending.push({
                fromId: entry.node.id,
                toPath,
                selStart,
                count,
                sourcePath: file,
              });
            }
          }
        }
      });

      // Commit: everything or nothing, so a crashed attempt stays idempotent.
      if (entries.length > 0) store.upsertNodes(entries.map((e) => e.node));
      for (const edge of fileEdges.values()) {
        store.addEdge('calls', edge.fromId, edge.toId, edge.count, file);
      }
      // Persist unresolved targets: an interrupted or crashed run must not
      // lose these edges (this file is about to be marked semanticDone and
      // will not be re-crawled until it changes).
      if (filePending.length > 0) {
        store.addPendingCalls(
          filePending.map((p) => ({
            fromId: p.fromId,
            toPath: p.toPath,
            selLine: p.selStart.line,
            selChar: p.selStart.character,
            count: p.count,
            sourcePath: p.sourcePath,
          })),
        );
      }

      const record = store.getFileRecord(file);
      if (record) {
        store.upsertFileRecord({ ...record, semanticDone: true });
      } else {
        const stat = statSync(absPath);
        store.upsertFileRecord({
          path: file,
          mtimeMs: Math.floor(stat.mtimeMs),
          size: stat.size,
          structuralDone: true,
          semanticDone: true,
        });
      }
      return { symbols: entries.length, callEdges: fileEdges.size };
    } finally {
      try {
        await client.closeDocument(file);
      } catch {
        // dead server; the crash path restarts it
      }
    }
  };

  try {
    for (const file of files) {
      if (isCancelled() || brokenBeyondRepair) break;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_FILE; attempt += 1) {
        try {
          const result = await processFile(file);
          totalSymbols += result.symbols;
          totalCallEdges += result.callEdges;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const died = error instanceof LspDeadError || !client.alive;
          if (!died) {
            // Non-crash failure (unreadable file, protocol error): skip the file.
            console.warn(`[indexer] semantic: skipping ${file}: ${message}`);
            break;
          }
          console.warn(
            `[indexer] semantic: language server died while processing ${file} ` +
              `(attempt ${attempt}/${MAX_ATTEMPTS_PER_FILE}); restarting`,
          );
          try {
            await client.restart();
            warmedUp = false;
          } catch (restartError) {
            const restartMessage =
              restartError instanceof Error ? restartError.message : String(restartError);
            console.warn(`[indexer] semantic: could not restart language server: ${restartMessage}`);
            brokenBeyondRepair = true;
            break;
          }
          if (attempt === MAX_ATTEMPTS_PER_FILE) {
            console.warn(`[indexer] semantic: giving up on ${file} after ${attempt} attempts`);
          }
        }
      }

      filesDone += 1;
      emit({
        type: 'progress',
        phase: 'semantic',
        filesDone,
        filesTotal,
        currentFile: file,
        symbols: totalSymbols,
        callEdges: totalCallEdges,
      });
      semanticTestHooks.onFileDone?.(file, client);
    }

    // Runs even when cancelled; rows that still don't resolve stay for the
    // next run.
    resolveStoredPendings();
  } finally {
    await client.dispose();
  }

  return { symbols: totalSymbols, callEdges: totalCallEdges };
}
