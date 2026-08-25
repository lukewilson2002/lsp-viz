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
  GraphStore,
  GraphViewResponse,
  IndexRequestBody,
  MetaResponse,
  NodeDetailResponse,
  SearchResponse,
  SourceResponse,
  TreeNode,
  TreeResponse,
  WsServerMessage,
} from '@lsp-viz/core';
import { ROOT_NODE_ID, isContainerKind, isSymbolKind } from '@lsp-viz/core';
import type { IndexMode, IndexProgressEvent, Indexer } from '@lsp-viz/indexer';

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
    const response: GraphViewResponse = view;
    return response;
  });

  app.get<{ Params: { id: string } }>('/api/node/:id', async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `unknown node: ${request.params.id}` });
    }
    const ancestors = store.getAncestors(node.id);
    const { incoming, outgoing } = store.getCalls(node.id);
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
      const start = Math.max(0, Math.min(node.range.start.line, lines.length - 1));
      const end = Math.max(start, Math.min(node.range.end.line, lines.length - 1));
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
