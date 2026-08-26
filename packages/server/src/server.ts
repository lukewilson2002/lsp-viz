/**
 * The HTTP/WS API: every route in `docs/CONTRACTS.md`'s server section, plus
 * the static frontend and the WebSocket that rebroadcasts index progress.
 * Response shapes come from `@lsp-viz/core`'s api.ts and nothing else.
 *
 * Two resolvers here are shared rather than per-route, and both exist because
 * two surfaces that must agree were previously free to disagree:
 *
 *  - {@link nodeLinks} is THE definition of "this node's links". /api/node/:id
 *    returns the lists, /api/graph counts the same lists into `linkCounts`, so
 *    a card's "8 out" can never expand to an empty panel.
 *  - `sourceLinks` decides which identifiers a source slice may turn into
 *    links. It lives here, not in the browser, because ambiguity has to be
 *    judged against the whole store and because the client would otherwise
 *    need 1 + N requests per selection to learn the same thing.
 *
 * Reads that touch the filesystem (/api/source) happen at request time — the
 * store holds the graph, never source text.
 */

import { existsSync } from 'node:fs';
import { open as openFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fuzzysort from 'fuzzysort';
import type { WebSocket } from 'ws';
import type {
  CallLink,
  EdgeKind,
  GraphNode,
  GraphStore,
  GraphViewResponse,
  IndexRequestBody,
  LinkCounts,
  MetaResponse,
  NodeDetailResponse,
  SearchResponse,
  SourceLink,
  SourceLinksResponse,
  SourceResponse,
  SymbolEntry,
  SymbolFileGroup,
  SymbolsResponse,
  TreeNode,
  TreeResponse,
  WsServerMessage,
} from '@lsp-viz/core';
import { ROOT_NODE_ID, edgeId, isContainerKind, isSymbolKind } from '@lsp-viz/core';
import type { IndexMode, IndexProgressEvent, Indexer } from '@lsp-viz/indexer';
import { scanLeadingComments } from './comments.js';

export interface BuildServerOptions {
  store: GraphStore;
  indexer: Indexer;
  /** Absolute path of the repo being served. */
  repoRoot: string;
  /** Absolute path to the built frontend (packages/web/dist). */
  webDist: string;
}

/**
 * The Fastify instance returned by {@link buildServer}, extended with the
 * index-event plumbing (broadcasting lives here in server.ts; the CLI wires
 * the indexer's onProgress to `broadcastIndexEvent`).
 */
export interface LspVizServer extends FastifyInstance {
  /** Forward one indexer progress event to every connected WebSocket client. */
  broadcastIndexEvent(event: IndexProgressEvent): void;
  /**
   * Kick off an index run in the background. Sync and async failures are
   * caught, logged, and broadcast as `index:error` — a throwing indexer never
   * crashes the server. Returns false only when a run is already in flight.
   */
  startIndexRun(mode: IndexMode): boolean;
}

/** Whole-file cap (file-node responses). */
const MAX_SOURCE_BYTES = 256 * 1024;
/**
 * Hard ceiling for reading a file to slice a symbol range out of it — the
 * CONTRACTS cap applies to file nodes only, and symbols can live past 256 KB
 * in files the indexer accepts (walk cap is 2 MB). Matches the walk cap.
 */
const MAX_SYMBOL_FILE_BYTES = 2 * 1024 * 1024;

/** Response caps for /api/symbols/:id — a monorepo package can hold tens of thousands. */
const MAX_SYMBOLS = 2000;
const MAX_GROUPS = 400;
/** Leading-comment scan budget for symbol source slices. */
const MAX_DOC_LINES = 40;
const MAX_DOC_SCAN = 200;

/** Read at most `cap` bytes of a regular file; throws on missing/non-file. */
async function readSourceCapped(absPath: string, cap: number): Promise<string> {
  const st = await stat(absPath);
  if (!st.isFile()) throw new Error(`not a regular file: ${absPath}`);
  if (st.size <= cap) {
    return readFile(absPath, 'utf8');
  }
  const handle = await openFile(absPath, 'r');
  try {
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The two directions of {@link nodeLinks}. */
interface NodeLinks {
  incoming: CallLink[];
  outgoing: CallLink[];
}

/** Fine edge kinds a subtree roll-up carries (containment is not an edge row). */
const ROLLUP_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'calls',
  'references',
  'extends',
  'implements',
];

/** One merged far end of a subtree roll-up, before its node is resolved. */
interface RolledLink {
  kind: EdgeKind;
  farId: string;
  count: number;
}

/**
 * THE definition of "this node's links" — used by GET /api/node/:id for the
 * lists and by GET /api/graph for `linkCounts`, so the summary a card shows
 * and the list it expands to are always the same set counted the same way.
 *
 * `store.getCalls` answers for the two node kinds whose edges are recorded ON
 * them: files (imports) and symbols with nothing nested inside (calls,
 * references, extends, implements). Everything that CONTAINS declarations —
 * a class, an interface, a function holding nested ones, and every
 * directory/package — is mostly not an edge endpoint itself: its links belong
 * to the things inside it. `getViewGraph` already rolls those onto the
 * containing card when it draws a view, so answering "0 links" here would
 * contradict the arrows the canvas draws out of that very card.
 *
 * So this rolls up: every link of the subtree whose far end lies OUTSIDE the
 * subtree, merged per (kind, far node) — a class calling one helper from three
 * methods is one link of weight 3 — with the node's own edges (a class's
 * `extends`) included unchanged.
 *
 * Containers deliberately do NOT use `store.getCalls`, which answers them from
 * `aggregate_edges`. Those rows only ever pair SIBLINGS under a shared parent,
 * so a lone child (`packages/math/src`, the only directory in its package)
 * reports nothing at all while the files under it import across the repo. The
 * roll-up reports what its contents actually touch, and keeps the far end as
 * the real file or symbol rather than a coarser stand-in.
 */
function nodeLinks(store: GraphStore, node: GraphNode): NodeLinks {
  // A file's imports ARE its links; rolling up the calls of its declarations
  // would restate the L4 call graph as an L3 summary and change what every
  // file card means.
  if (node.kind === 'file') return store.getCalls(node.id);
  const descendants = store.getDescendants(node.id);
  if (descendants.length === 0) return store.getCalls(node.id);

  const inside = new Set<string>([node.id, ...descendants.map((d) => d.id)]);
  // One chunked query for the whole subtree rather than getCalls() per
  // descendant: /api/graph rolls up every child of a view, and a package
  // subtree runs to hundreds of nodes.
  const edges = store.getEdgesTouching([...inside], ROLLUP_EDGE_KINDS);

  const incoming = new Map<string, RolledLink>();
  const outgoing = new Map<string, RolledLink>();
  for (const edge of edges) {
    const fromInside = inside.has(edge.from);
    const toInside = inside.has(edge.to);
    // Both ends inside describes the node's insides, not its links.
    if (fromInside === toInside) continue;
    const into = toInside ? incoming : outgoing;
    const farId = toInside ? edge.from : edge.to;
    const key = `${edge.kind}|${farId}`;
    const existing = into.get(key);
    if (existing) existing.count += edge.count;
    else into.set(key, { kind: edge.kind, farId, count: edge.count });
  }

  const farIds = new Set<string>();
  for (const link of incoming.values()) farIds.add(link.farId);
  for (const link of outgoing.values()) farIds.add(link.farId);
  const farNodes = new Map(store.getNodes([...farIds]).map((n) => [n.id, n]));

  const build = (merged: Map<string, RolledLink>, direction: 'incoming' | 'outgoing'): CallLink[] => {
    const links: CallLink[] = [];
    for (const { kind, farId, count } of merged.values()) {
      const far = farNodes.get(farId);
      // An edge whose far end is gone has nothing to name or navigate to.
      if (!far) continue;
      const from = direction === 'incoming' ? farId : node.id;
      const to = direction === 'incoming' ? node.id : farId;
      // Deterministic and collision-free: identical to the real edge id when
      // the node itself is the endpoint (`extends`), synthetic otherwise.
      links.push({ edge: { id: edgeId(kind, from, to), kind, from, to, count }, node: far });
    }
    return links;
  };
  return { incoming: build(incoming, 'incoming'), outgoing: build(outgoing, 'outgoing') };
}

/**
 * Identifier gate for {@link sourceLinks}. Anything else can never occur as a
 * bare identifier in source, and letting non-identifiers through is how a file
 * node's `imports` far ends (`index.ts`) would turn every module specifier and
 * every JSDoc path into a link.
 */
const LINK_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The edge kinds whose far end is a declaration this node's text names. */
const LINK_EDGE_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'references',
  'extends',
  'implements',
]);

/**
 * The identifiers a node's source slice may turn into links, in one store pass.
 *
 * Three tiers, best first, and a higher tier is never poisoned by a lower one:
 *  P1  the node's own resolved links — what the LSP actually bound (the callee,
 *      the referenced constant, the imported type). Empty for a file node,
 *      whose only edges are file-to-file `imports`.
 *  P2  the link file's own top-level declarations — a name declared right here.
 *  P3  the top-level declarations of the files it imports, plus ONE hop through
 *      a directly-imported file that declares nothing itself, which is what a
 *      barrel (`export * from './format.js'`) looks like in the graph.
 *
 * Depth-0 only, everywhere. Function-local names are where matching by NAME is
 * both least useful (the declaration is three lines up, on screen) and most
 * ambiguous — locals called `rows` or `run` exist in dozens of functions.
 *
 * Ambiguity within a tier removes the name outright: a link that jumps to the
 * wrong symbol is worse than no link, and the only undo is Back. Repeats of the
 * SAME id must not poison, so ids are compared, never occurrence counts — P1
 * legitimately yields one far node twice when two edge kinds connect them.
 */
function sourceLinks(store: GraphStore, node: GraphNode): SourceLink[] {
  const linkFile =
    node.kind === 'file'
      ? node
      : isSymbolKind(node.kind)
        ? ([...store.getAncestors(node.id)].reverse().find((a) => a.kind === 'file') ??
          store.getNodesByPath(node.path).find((n) => n.kind === 'file'))
        : undefined;
  if (!linkFile) return [];

  const declarationsOf = (fileId: string): GraphNode[] =>
    store.getChildren(fileId).filter((n) => isSymbolKind(n.kind));

  const tier1: GraphNode[] = [];
  for (const link of nodeLinks(store, node).outgoing) {
    if (LINK_EDGE_KINDS.has(link.edge.kind) && isSymbolKind(link.node.kind)) tier1.push(link.node);
  }

  const tier3: GraphNode[] = [];
  for (const imported of store.getCalls(linkFile.id).outgoing) {
    if (imported.edge.kind !== 'imports' || imported.node.kind !== 'file') continue;
    const direct = declarationsOf(imported.node.id);
    if (direct.length > 0) {
      tier3.push(...direct);
      continue;
    }
    // A barrel declares nothing; the names it re-exports live one hop further.
    for (const reExported of store.getCalls(imported.node.id).outgoing) {
      if (reExported.edge.kind !== 'imports' || reExported.node.kind !== 'file') continue;
      tier3.push(...declarationsOf(reExported.node.id));
    }
  }

  const claimed = new Map<string, string>();
  for (const tier of [tier1, declarationsOf(linkFile.id), tier3]) {
    const owners = new Map<string, string | null>();
    for (const candidate of tier) {
      if (!LINK_NAME_RE.test(candidate.name)) continue;
      if (claimed.has(candidate.name)) continue;
      const owner = owners.get(candidate.name);
      if (owner === undefined) owners.set(candidate.name, candidate.id);
      else if (owner !== null && owner !== candidate.id) owners.set(candidate.name, null);
    }
    for (const [name, owner] of owners) {
      if (owner !== null) claimed.set(name, owner);
    }
  }

  return [...claimed].map(([name, nodeId]) => ({ name, nodeId }));
}

export async function buildServer(opts: BuildServerOptions): Promise<LspVizServer> {
  const { store, indexer } = opts;
  const repoRoot = path.resolve(opts.repoRoot);
  const webDist = path.resolve(opts.webDist);

  const app = Fastify({ logger: false });

  // Must be registered before any route that uses { websocket: true }.
  await app.register(fastifyWebsocket);

  // ---------------------------------------------------------------- WebSocket

  const sockets = new Set<WebSocket>();

  const broadcast = (message: WsServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const toWsMessage = (event: IndexProgressEvent): WsServerMessage => {
    switch (event.type) {
      case 'phase':
        return { type: 'index:progress', phase: event.phase, filesDone: 0, filesTotal: 0 };
      case 'progress':
        return {
          type: 'index:progress',
          phase: event.phase,
          filesDone: event.filesDone,
          filesTotal: event.filesTotal,
          currentFile: event.currentFile,
          symbols: event.symbols,
          callEdges: event.callEdges,
        };
      case 'done':
        return { type: 'index:done', stats: event.stats };
      case 'error':
        return { type: 'index:error', message: event.message };
    }
  };

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  // ---------------------------------------------------------------- API

  app.get<{ Querystring: { parent?: string } }>('/api/graph', async (request, reply) => {
    const parentId =
      request.query.parent !== undefined && request.query.parent !== ''
        ? request.query.parent
        : ROOT_NODE_ID;
    const view = store.getViewGraph(parentId);
    if (!view) {
      return reply.code(404).send({ error: `unknown node: ${parentId}` });
    }
    // Every card's links row reads these; computing them here keeps it to one
    // request per view instead of one per card (see GraphViewResponse.linkCounts).
    const linkCounts: Record<string, LinkCounts> = {};
    for (const child of view.children) {
      const { incoming, outgoing } = nodeLinks(store, child);
      linkCounts[child.id] = { inCount: incoming.length, outCount: outgoing.length };
    }
    // The container each portal ghost can roll up onto (GraphViewResponse
    // .externalParents). Excluded: anything already drawn here (a roll-up
    // target on screen would be a second card for one node) and the view's own
    // ancestors — those are what the view is INSIDE, so rolling a ghost onto
    // one would point up the tree instead of sideways to a neighbour.
    const drawn = new Set<string>([
      view.parent.id,
      ...store.getAncestors(view.parent.id).map((a) => a.id),
      ...view.children.map((c) => c.id),
      ...view.externalNodes.map((n) => n.id),
    ]);
    const parentIds = new Set<string>();
    for (const external of view.externalNodes) {
      if (external.parentId !== null && !drawn.has(external.parentId)) {
        parentIds.add(external.parentId);
      }
    }
    const response: GraphViewResponse = {
      ...view,
      externalParents: store.getNodes([...parentIds]),
      linkCounts,
    };
    return response;
  });

  app.get<{ Params: { id: string } }>('/api/node/:id', async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `unknown node: ${request.params.id}` });
    }
    const ancestors = store.getAncestors(node.id);
    const { incoming, outgoing } = nodeLinks(store, node);
    const childCount = store.getChildren(node.id).length;
    const response: NodeDetailResponse = {
      node,
      ancestors,
      incoming,
      outgoing,
      metrics: {
        inCount: incoming.length,
        outCount: outgoing.length,
        childCount,
      },
    };
    return response;
  });

  app.get<{ Params: { id: string } }>('/api/source/:id', async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `unknown node: ${request.params.id}` });
    }
    if (node.path === '') {
      return reply.code(404).send({ error: 'node has no source file' });
    }
    // Path traversal guard: the resolved path must stay inside the repo root.
    const absPath = path.resolve(repoRoot, node.path);
    if (!absPath.startsWith(repoRoot + path.sep)) {
      return reply.code(404).send({ error: 'path outside repository' });
    }
    const sliceSymbol = isSymbolKind(node.kind) && node.range !== undefined;
    let text: string;
    try {
      text = await readSourceCapped(
        absPath,
        sliceSymbol ? MAX_SYMBOL_FILE_BYTES : MAX_SOURCE_BYTES,
      );
    } catch {
      return reply.code(404).send({ error: `source file not readable: ${node.path}` });
    }

    const lines = text.split('\n');
    let startLine = 1;
    let endLine = lines.length;
    if (isSymbolKind(node.kind) && node.range) {
      const decl = Math.max(0, Math.min(node.range.start.line, lines.length - 1));
      const end = Math.max(decl, Math.min(node.range.end.line, lines.length - 1));

      // Floor: never scan up past a sibling declaration that ends above us, so a
      // trailing comment belonging to the PREVIOUS symbol can't be absorbed.
      let floor = 0;
      if (node.parentId !== null) {
        for (const sib of store.getChildren(node.parentId)) {
          if (sib.id === node.id || !sib.range) continue;
          if (sib.range.end.line < decl) floor = Math.max(floor, sib.range.end.line + 1);
        }
      }

      const start = scanLeadingComments(lines, decl, {
        floorLine: floor,
        maxDocLines: MAX_DOC_LINES,
        maxScan: MAX_DOC_SCAN,
      });

      startLine = start + 1;
      endLine = end + 1;
      text = lines.slice(start, end + 1).join('\n');
    }
    const response: SourceResponse = {
      path: node.path,
      language: node.language,
      startLine,
      endLine,
      text,
    };
    return response;
  });

  /**
   * The clickable identifiers for a node's source slice. Resolved server-side
   * because the client would otherwise need 1 + N (+ a barrel hop) requests per
   * selection to learn the same thing, and because ambiguity has to be judged
   * against the whole store, not against one response.
   */
  app.get<{ Params: { id: string } }>('/api/links/:id', async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `unknown node: ${request.params.id}` });
    }
    const response: SourceLinksResponse = { nodeId: node.id, links: sourceLinks(store, node) };
    return response;
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', async (request) => {
    const query = (request.query.q ?? '').trim();
    if (query === '') {
      const empty: SearchResponse = { results: [] };
      return empty;
    }
    const candidates = store.searchCandidates(query, 500);
    const ranked = fuzzysort.go(query, candidates, {
      keys: ['name', 'path'],
      limit: 50,
      threshold: 0,
      // Prefer name matches over path-only matches.
      scoreFn: (result) => Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.8),
    });
    const response: SearchResponse = {
      results: ranked.map((result) => ({ node: result.obj, score: result.score })),
    };
    return response;
  });

  /**
   * The declarations in or under a node, grouped by the file that declares
   * them. Scope is derived from the node's kind, never from a query param, so
   * a given node id always answers the same question.
   */
  app.get<{ Params: { id: string } }>('/api/symbols/:id', async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `unknown node: ${request.params.id}` });
    }

    const scope: SymbolsResponse['scope'] = isContainerKind(node.kind)
      ? 'descendants'
      : node.kind === 'file'
        ? 'file'
        : 'members';

    const descendants = store.getDescendants(node.id);

    // parentId -> children, over the descendant set only.
    const childrenOf = new Map<string, GraphNode[]>();
    for (const d of descendants) {
      if (d.parentId === null) continue;
      const list = childrenOf.get(d.parentId);
      if (list) list.push(d);
      else childrenOf.set(d.parentId, [d]);
    }

    /** { file that declares them, node to start the DFS from }. */
    const roots: { file: GraphNode; startId: string }[] = [];
    if (scope === 'descendants') {
      for (const d of descendants) if (d.kind === 'file') roots.push({ file: d, startId: d.id });
    } else if (scope === 'file') {
      roots.push({ file: node, startId: node.id });
    } else {
      const file =
        [...store.getAncestors(node.id)].reverse().find((a) => a.kind === 'file') ??
        store.getNodesByPath(node.path).find((n) => n.kind === 'file');
      if (file) roots.push({ file, startId: node.id });
    }

    /** Source-order sort key; range-less nodes sort last. */
    const orderKey = (n: GraphNode): number =>
      n.range
        ? n.range.start.line * 1000 + Math.min(n.range.start.character, 999)
        : Number.MAX_SAFE_INTEGER;

    let totalSymbols = 0;
    const collect = (startId: string, depth: number, out: SymbolEntry[]): void => {
      const kids = (childrenOf.get(startId) ?? []).filter((k) => isSymbolKind(k.kind));
      kids.sort((a, b) => orderKey(a) - orderKey(b) || a.name.localeCompare(b.name));
      for (const k of kids) {
        out.push({ id: k.id, kind: k.kind, name: k.name, depth });
        totalSymbols++;
        collect(k.id, depth + 1, out);
      }
    };

    const relPathOf = (filePath: string): string =>
      filePath === node.path
        ? ''
        : node.path !== '' && filePath.startsWith(`${node.path}/`)
          ? filePath.slice(node.path.length + 1)
          : filePath;

    const built: SymbolFileGroup[] = [];
    for (const { file, startId } of roots) {
      const symbols: SymbolEntry[] = [];
      collect(startId, 0, symbols);
      if (symbols.length === 0) continue;
      built.push({
        fileId: file.id,
        name: file.name,
        path: file.path,
        relativePath: relPathOf(file.path),
        symbols,
        omitted: 0,
      });
    }
    built.sort((a, b) => a.path.localeCompare(b.path));

    const totalFiles = built.length;
    let truncated = totalFiles > MAX_GROUPS;
    const groups: SymbolFileGroup[] = [];
    let budget = MAX_SYMBOLS;
    for (const g of built.slice(0, MAX_GROUPS)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      if (g.symbols.length > budget) {
        groups.push({
          ...g,
          symbols: g.symbols.slice(0, budget),
          omitted: g.symbols.length - budget,
        });
        budget = 0;
        truncated = true;
      } else {
        groups.push(g);
        budget -= g.symbols.length;
      }
    }

    const response: SymbolsResponse = {
      nodeId: node.id,
      scope,
      groups,
      totalFiles,
      totalSymbols,
      truncated,
    };
    return response;
  });

  app.get('/api/tree', async (_request, reply) => {
    const root = store.getNode(ROOT_NODE_ID);
    if (!root) {
      return reply.code(404).send({ error: 'repository not indexed yet' });
    }
    // Containment skeleton only: containers + files, no symbols.
    const structural = store
      .getDescendants(ROOT_NODE_ID)
      .filter((n) => isContainerKind(n.kind) || n.kind === 'file');
    const childrenOf = new Map<string, TreeNode[]>();
    const treeNodes = new Map<string, TreeNode>();
    const toTree = (n: {
      id: string;
      name: string;
      kind: TreeNode['kind'];
      path: string;
    }): TreeNode => ({ id: n.id, name: n.name, kind: n.kind, path: n.path });
    for (const n of structural) treeNodes.set(n.id, toTree(n));
    const rootTree = toTree(root);
    treeNodes.set(root.id, rootTree);
    for (const n of structural) {
      if (n.parentId === null) continue;
      const list = childrenOf.get(n.parentId);
      const tree = treeNodes.get(n.id);
      if (!tree) continue;
      if (list) list.push(tree);
      else childrenOf.set(n.parentId, [tree]);
    }
    const rankOf = (t: TreeNode): number => (t.kind === 'file' ? 1 : 0);
    for (const [parentId, list] of childrenOf) {
      list.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));
      const parent = treeNodes.get(parentId);
      if (parent) parent.children = list;
    }
    // Containers always carry a children array, even when empty.
    for (const t of treeNodes.values()) {
      if (t.kind !== 'file' && t.children === undefined) t.children = [];
    }
    const response: TreeResponse = { root: rootTree };
    return response;
  });

  app.get('/api/meta', async () => {
    const stats = store.stats();
    const response: MetaResponse = {
      repoRoot,
      repoName: path.basename(repoRoot),
      indexedAt: store.getMeta('indexedAt'),
      indexing: indexer.running,
      stats: { nodes: stats.nodes, edges: stats.edges, files: stats.files },
    };
    return response;
  });

  app.post<{ Body: IndexRequestBody | null }>('/api/index', async (request, reply) => {
    if (indexer.running) {
      return reply.code(409).send({ error: 'an index run is already in progress' });
    }
    server.startIndexRun(request.body?.full === true ? 'full' : 'diff');
    return { started: true };
  });

  // ---------------------------------------------------------------- static SPA

  const hasWebDist = existsSync(path.join(webDist, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        !url.startsWith('/api') &&
        !url.startsWith('/ws')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    console.warn(
      `[lsp-viz] warning: web dist not found at ${webDist} — serving API only (build @lsp-viz/web to get the UI)`,
    );
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));
  }

  // ---------------------------------------------------------------- index plumbing

  const server = app as unknown as LspVizServer;

  server.decorate('broadcastIndexEvent', (event: IndexProgressEvent): void => {
    broadcast(toWsMessage(event));
  });

  server.decorate('startIndexRun', (mode: IndexMode): boolean => {
    if (indexer.running) return false;
    const fail = (err: unknown): void => {
      const message = errorMessage(err);
      console.error(`[lsp-viz] index ${mode} run failed: ${message}`);
      broadcast({ type: 'index:error', message });
    };
    try {
      indexer.run(mode).then((stats) => {
        console.log(
          `[lsp-viz] index ${mode} complete: files=${stats.files} nodes=${stats.nodes} ` +
            `edges=${stats.edges} duration=${stats.durationMs}ms`,
        );
      }, fail);
    } catch (err) {
      // A synchronously-throwing indexer must not take the server down.
      fail(err);
    }
    return true;
  });

  return server;
}
