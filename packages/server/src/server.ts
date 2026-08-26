/**
 * The HTTP/WS transport: every route in `docs/CONTRACTS.md`'s server section
 * mapped onto {@link createApi}, plus the static frontend and the WebSocket
 * that rebroadcasts index progress.
 *
 * Deliberately thin. All resolution logic — what a node's links are, which
 * identifiers a source slice may link, how symbols are grouped and capped —
 * lives in `api.ts`, because the desktop app reaches the same methods over IPC
 * and a rule that lived here would be a rule that build gets wrong. A route
 * body here should do nothing but unpack params, call one API method, and map
 * an {@link ApiRouteError} onto its status.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GraphStore, IndexRequestBody, WsServerMessage } from '@lsp-viz/core';
import type { IndexMode, IndexProgressEvent, Indexer } from '@lsp-viz/indexer';
import type { WebSocket } from 'ws';
import { ApiRouteError, createApi } from './api.js';
import type { LspVizApi } from './api.js';

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
 * index-event plumbing (the CLI wires the indexer's onProgress to
 * `broadcastIndexEvent`).
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
  /** The transport-free API these routes delegate to. */
  readonly api: LspVizApi;
}

/**
 * Run one API call and turn an {@link ApiRouteError} into the status the
 * contract gives it. Anything else is a bug, and Fastify's 500 is the honest
 * answer for a bug.
 */
async function route<T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiRouteError) {
      await reply.code(err.status).send({ error: err.message });
      return undefined;
    }
    throw err;
  }
}

export async function buildServer(opts: BuildServerOptions): Promise<LspVizServer> {
  const webDist = path.resolve(opts.webDist);
  const api = createApi({
    store: opts.store,
    indexer: opts.indexer,
    repoRoot: opts.repoRoot,
  });

  const app = Fastify({ logger: false });

  // Must be registered before any route that uses { websocket: true }.
  await app.register(fastifyWebsocket);

  // ---------------------------------------------------------------- WebSocket

  const sockets = new Set<WebSocket>();

  api.subscribe((message: WsServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  });

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  // ---------------------------------------------------------------- API

  app.get<{ Querystring: { parent?: string } }>('/api/graph', (request, reply) =>
    route(reply, () => api.graph(request.query.parent)),
  );

  app.get<{ Params: { id: string } }>('/api/node/:id', (request, reply) =>
    route(reply, () => api.nodeDetail(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/source/:id', (request, reply) =>
    route(reply, () => api.source(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/links/:id', (request, reply) =>
    route(reply, () => api.links(request.params.id)),
  );

  app.get<{ Querystring: { q?: string } }>('/api/search', (request, reply) =>
    route(reply, () => api.search(request.query.q ?? '')),
  );

  app.get<{ Params: { id: string } }>('/api/symbols/:id', (request, reply) =>
    route(reply, () => api.symbols(request.params.id)),
  );

  app.get('/api/tree', (_request, reply) => route(reply, () => api.tree()));

  app.get('/api/meta', (_request, reply) => route(reply, () => api.meta()));

  app.post<{ Body: IndexRequestBody | null }>('/api/index', (request, reply) =>
    route(reply, () => api.startIndex(request.body)),
  );

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

  server.decorate('api', api);
  server.decorate('broadcastIndexEvent', (event: IndexProgressEvent): void => {
    api.publish(event);
  });
  server.decorate('startIndexRun', (mode: IndexMode): boolean => api.startIndexRun(mode));

  return server;
}
