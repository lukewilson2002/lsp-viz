/**
 * Semantic phase: LSP-driven symbol, call-graph and reference extraction.
 *
 * Sweep 1, per file: didOpen → documentSymbol → symbol GraphNodes (deterministic
 * ids), then hover (signatures) and call hierarchy (calls edges) pipelined
 * through a bounded promise pool → didClose. Call targets in files not yet
 * processed go to a pending list retried once after all files complete.
 *
 * Sweep 2, per file: textDocument/references on every card-level declaration →
 * `references` edges for uses that are not calls (a type annotation, a default
 * parameter value, a const read). It is a SEPARATE sweep because the `calls`
 * edge that would duplicate a reference pair is produced while crawling the
 * caller's file, which may sort after the declaration's — dedup is only correct
 * once every file's symbols and calls are stored.
 *
 * Both sweeps survive language-server crashes: a dead child is restarted and the
 * file retried (max 2 attempts per file).
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { edgeId, isSymbolKind, nodeId } from '@lsp-viz/core';
import type { GraphEdge, GraphNode, GraphStore, NodeKind, Position, Range } from '@lsp-viz/core';
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
  /**
   * Files (repo-relative, posix) whose declarations get a reference sweep. On a
   * diff run this is the import closure of the changed files, not just the
   * changed files: a reference edge is PRODUCED while crawling the referent's
   * file but OWNED (sourcePath) by the referrer's, so a changed referrer drops
   * edges only its importees can recreate.
   */
  referenceFiles: string[];
  /** Max in-flight LSP requests. */
  concurrency: number;
  emit: (e: IndexProgressEvent) => void;
  isCancelled: () => boolean;
}

/** Test-only lifecycle hooks (crash-recovery tests observe/kill the child). */
export interface SemanticTestHooks {
  /**
   * Called after each file finishes (success or give-up), with the live
   * client. Fires once per file per SWEEP, so a file appears twice in a run
   * that does both — a test counting invocations must expect that.
   */
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

/** One (source symbol → referenced declaration) pair accumulated for a file. */
interface RefPair {
  fromId: string;
  toId: string;
  count: number;
  /** File containing the SOURCE symbol — not necessarily the crawled file. */
  sourcePath: string;
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

/**
 * The card a use site belongs to: the smallest symbol node containing `pos`,
 * then climb out of anonymous nesting (inline callbacks, nested helpers) until
 * the parent is the file node or a class/interface. That matches how call
 * hierarchy already collapses `cells.map((c) => padCell(c))` onto `formatRow`,
 * while stopping at a method instead of swallowing it into its class.
 *
 * Returns null when `pos` is inside no symbol at all — notably an
 * `import { x } from '…'` specifier, which the graph already carries as an
 * `imports` edge at file granularity; `references` is symbol → symbol.
 *
 * Every parent of a file's symbols lives in that same file's node set, so this
 * needs no store lookups and is unit-testable without a language server.
 */
export function enclosingCardSymbol(
  fileNodes: readonly GraphNode[],
  pos: Position,
): GraphNode | null {
  let best: GraphNode | null = null;
  for (const node of fileNodes) {
    if (!isSymbolKind(node.kind)) continue;
    if (!node.range || !rangeContains(node.range, pos)) continue;
    if (best === null || rangeSize(node.range) < rangeSize(best.range as Range)) best = node;
  }
  if (best === null) return null;
  const byId = new Map(fileNodes.map((n) => [n.id, n]));
  for (;;) {
    const parentId: string | null = best.parentId;
    if (parentId === null) return best;
    const parent = byId.get(parentId);
    if (!parent || !isSymbolKind(parent.kind)) return best;
    if (parent.kind === 'class' || parent.kind === 'interface') return best;
    best = parent;
  }
}

/**
 * True when either id is a containment ancestor of the other. Kills the
 * self-edges of recursion and of `class Vector2 { plus(): Vector2 }`. Both ids
 * must belong to `fileNodes` (containment never crosses a file boundary below
 * the file node, so a cross-file pair is related by construction: never).
 */
function isContainmentRelated(fileNodes: readonly GraphNode[], a: string, b: string): boolean {
  const byId = new Map(fileNodes.map((n) => [n.id, n]));
  const climbsTo = (from: string, target: string): boolean => {
    let cur = byId.get(from);
    while (cur && cur.parentId !== null) {
      if (cur.parentId === target) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };
  return climbsTo(a, b) || climbsTo(b, a);
}

/** Swallow per-request server errors; only a dead process aborts the file. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LspDeadError) throw error;
    return null;
  }
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
): Promise<{ symbols: number; callEdges: number; refEdges: number }> {
  const { repoRoot, store, adapter, files, referenceFiles, concurrency, emit, isCancelled } = ctx;
  let totalSymbols = 0;
  let totalCallEdges = 0;
  let totalRefEdges = 0;

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

  // A diff run can have nothing to re-crawl but still owe a reference sweep.
  if (files.length === 0 && referenceFiles.length === 0) {
    resolveStoredPendings();
    return { symbols: 0, callEdges: totalCallEdges, refEdges: 0 };
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
    return { symbols: 0, callEdges: 0, refEdges: 0 };
  }

  // Both sweeps report into one counter: restarting at 0 for sweep 2 would make
  // the status bar look like the semantic phase ran twice.
  const filesTotal = files.length + referenceFiles.length;
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
              const key = `${entry.node.id}\u0000${toId}`;
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

  /**
   * Sweep 2 for one file: `references` edges for this file's declarations.
   *
   * One request per DECLARATION (a few hundred on this repo) rather than one
   * textDocument/definition per identifier (tens of thousands, plus a
   * language-specific identifier query the adapter interface does not carry).
   * References also answer with a URI, so cross-file uses work —
   * documentHighlight has no URI field at all and could never do that.
   */
  const processReferenceFile = async (file: string): Promise<number> => {
    const fileId = fileNodeId(file);
    const nodesByPath = new Map<string, GraphNode[]>();
    const nodesFor = (relPath: string): GraphNode[] => {
      let nodes = nodesByPath.get(relPath);
      if (nodes === undefined) {
        nodes = store.getNodesByPath(relPath);
        nodesByPath.set(relPath, nodes);
      }
      return nodes;
    };

    // Targets are exactly the cards an L4 file view draws, read from the store
    // (sweep 1 already asked documentSymbol). Function-local variables would
    // each emit a self-loop from their own enclosing function; class/interface
    // members would turn one `new Vector2(...)` into both →constructor and
    // →Vector2. Members stay valid SOURCES. Barrels declare nothing, so this
    // also spares them a pointless didOpen round trip.
    const decls = nodesFor(file).filter(
      (n) => n.parentId === fileId && isSymbolKind(n.kind) && n.selectionRange !== undefined,
    );
    if (decls.length === 0) return 0;

    const absPath = path.join(repoRoot, file);
    const text = readFileSync(absPath, 'utf8');
    // MANDATORY: tsserver answers a reference request for a closed document
    // with [] rather than an error — silent data loss, not a failure.
    await client.openDocument(file, text);
    try {
      // Same reason: a cold server also answers []. Warm it on the open file.
      if (!warmedUp) {
        for (let attempt = 0; attempt < WARMUP_RETRIES && !isCancelled(); attempt += 1) {
          const probe = await client.documentSymbols(file);
          if (probe !== null && probe.length > 0) break;
          await delay(WARMUP_DELAY_MS);
        }
        warmedUp = true;
      }

      const pairs = new Map<string, RefPair>();
      await runPool(decls, concurrency, async (decl) => {
        if (isCancelled()) return;
        const sel = decl.selectionRange as Range;
        const locations = await guarded(() => client.references(file, sel.start, false));
        for (const loc of locations ?? []) {
          const usePath = uriToRepoRelative(loc.uri, repoRoot);
          if (usePath === null) continue; // use site outside the repo
          const useNodes = nodesFor(usePath);
          if (useNodes.length === 0) continue; // skipped or failed file
          const source = enclosingCardSymbol(useNodes, loc.range.start);
          if (source === null || source.id === decl.id) continue;
          if (usePath === file && isContainmentRelated(useNodes, source.id, decl.id)) continue;
          const key = `${source.id}\u0000${decl.id}`;
          const existing = pairs.get(key);
          if (existing) existing.count += 1;
          else {
            pairs.set(key, {
              fromId: source.id,
              toId: decl.id,
              count: 1,
              sourcePath: source.path,
            });
          }
        }
      });
      if (pairs.size === 0) return 0;

      // A pair that already calls its target would get a dotted line painted
      // exactly on top of the solid one. `calls` is the stronger fact; it wins.
      const fromIds = [...new Set([...pairs.values()].map((p) => p.fromId))];
      const callPairs = new Set(
        store.getEdgesTouching(fromIds, ['calls']).map((e) => `${e.from}\u0000${e.to}`),
      );
      const edges: GraphEdge[] = [];
      for (const [key, pair] of pairs) {
        if (callPairs.has(key)) continue;
        edges.push({
          id: edgeId('references', pair.fromId, pair.toId),
          kind: 'references',
          from: pair.fromId,
          to: pair.toId,
          count: pair.count,
          // CONTRACTS: sourcePath is the file containing the SOURCE symbol —
          // which is not `file` for a cross-file reference.
          sourcePath: pair.sourcePath,
        });
      }
      // upsertEdges (absolute), never addEdge (accumulating): this edge is
      // produced while crawling a file that is not its sourcePath, so
      // deleteFileData has not cleared it first and addEdge would double every
      // count on every diff run.
      if (edges.length > 0) store.upsertEdges(edges);
      return edges.length;
    } finally {
      try {
        await client.closeDocument(file);
      } catch {
        // dead server; the crash path restarts it
      }
    }
  };

  /** Per-file driver shared by both sweeps: bounded retries, crash restart, progress. */
  const processFilesWithRetry = async (
    batch: readonly string[],
    unit: (file: string) => Promise<void>,
  ): Promise<void> => {
    for (const file of batch) {
      if (isCancelled() || brokenBeyondRepair) break;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_FILE; attempt += 1) {
        try {
          await unit(file);
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
  };

  try {
    await processFilesWithRetry(files, async (file) => {
      const result = await processFile(file);
      totalSymbols += result.symbols;
      totalCallEdges += result.callEdges;
    });

    // BEFORE sweep 2, not after: a cross-file call whose target file sorted
    // later is still sitting in pending_calls, and the reference sweep's
    // calls-wins dedup reads the edges table. Draining it here is what stops
    // every cross-package call from also getting a duplicate dotted edge.
    // Runs even when cancelled; rows that still don't resolve stay for the
    // next run.
    resolveStoredPendings();

    // Only now is every file's symbol and call data stored, so the dedup
    // inside the reference sweep sees the whole picture.
    await processFilesWithRetry(referenceFiles, async (file) => {
      totalRefEdges += await processReferenceFile(file);
    });
  } finally {
    await client.dispose();
  }

  return { symbols: totalSymbols, callEdges: totalCallEdges, refEdges: totalRefEdges };
}
