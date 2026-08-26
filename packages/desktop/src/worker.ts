/**
 * The backend, as one Electron utility process per open repo.
 *
 * This is the same triple the `lsp-viz` CLI builds — GraphStore + Indexer +
 * `createApi` — with IPC where the CLI puts Fastify. Keeping all three here
 * (rather than the store in main and the indexer out here) means exactly one
 * SQLite connection per repo, so the desktop app's concurrency story is
 * identical to the CLI's instead of being a second thing to reason about.
 *
 * It runs out of the main process because indexing is not cheap: the
 * structural pass parses every file with tree-sitter and the semantic pass
 * pipelines 16 in-flight LSP requests, both of which would jank a window that
 * is supposed to stay usable *while* they run. A utility process gets a full
 * Node environment (native modules included) and takes the language server's
 * crashes with it, not the UI's.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { GraphStore, repoHash } from '@lsp-viz/core';
import { createIndexer } from '@lsp-viz/indexer';
import type { IndexProgressEvent, Indexer } from '@lsp-viz/indexer';
import { ApiRouteError, createApi } from '@lsp-viz/server/api';
import type { LspVizApi } from '@lsp-viz/server/api';
import type { WorkerMessage, WorkerRequest } from './worker-protocol.js';

/**
 * The language server is spawned as `process.execPath <tsserver-cli> --stdio`
 * (see the indexer's TypeScript adapter), and in here `process.execPath` is
 * the Electron binary. This flag is what makes that binary behave as plain
 * Node when it re-executes itself — the same trick VS Code uses to run its
 * language servers without shipping a second Node runtime. `spawn` inherits
 * this env, so setting it once here covers every restart the crawler does.
 *
 * Without it, each crawl would boot a whole second copy of the app.
 */
process.env.ELECTRON_RUN_AS_NODE = '1';

const port = process.parentPort;

function send(message: WorkerMessage): void {
  port.postMessage(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const repoArg = argOf('--repo');
if (repoArg === undefined) {
  send({ type: 'fatal', message: 'worker started without --repo' });
  process.exit(1);
}

const repoRoot = path.resolve(repoArg);
if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
  send({ type: 'fatal', message: `not a directory: ${repoRoot}` });
  process.exit(1);
}

// Same location the CLI uses, deliberately: indexing a repo in one and opening
// it in the other should hit the same warm database, not re-crawl it.
const dbPath =
  argOf('--db') ?? path.join(homedir(), '.cache', 'lsp-viz', `${repoHash(repoRoot)}.db`);
mkdirSync(path.dirname(dbPath), { recursive: true });

const store = new GraphStore(dbPath);

// Progress events flow indexer -> forward -> IPC; `forward` is rebound once
// the api exists (the indexer is built first because the api takes it).
let forward: (event: IndexProgressEvent) => void = () => {};

let indexer: Indexer;
try {
  indexer = createIndexer({ repoRoot, store, onProgress: (event) => forward(event) });
} catch (err) {
  // A broken indexer must not stop us serving an already-built database.
  const message = errorMessage(err);
  console.error(`[lsp-viz] failed to create indexer: ${message}`);
  indexer = {
    run: () => Promise.reject(new Error(`indexer unavailable: ${message}`)),
    cancel: () => Promise.resolve(),
    running: false,
  };
}

const api: LspVizApi = createApi({ store, indexer, repoRoot });
forward = (event) => api.publish(event);

api.subscribe((message) => send({ type: 'event', message }));

/** Node id params are required; a missing one is the caller's bug, not a 404. */
function requireId(id: string | undefined): string {
  if (id === undefined || id === '') throw new ApiRouteError(400, 'missing node id');
  return id;
}

async function dispatch(request: Extract<WorkerRequest, { type: 'call' }>): Promise<unknown> {
  const { route, params } = request;
  switch (route) {
    case 'graph':
      return api.graph(params.parent);
    case 'nodeDetail':
      return api.nodeDetail(requireId(params.id));
    case 'source':
      return api.source(requireId(params.id));
    case 'links':
      return api.links(requireId(params.id));
    case 'search':
      return api.search(params.q ?? '');
    case 'symbols':
      return api.symbols(requireId(params.id));
    case 'tree':
      return api.tree();
    case 'meta':
      return api.meta();
    case 'startIndex':
      return api.startIndex({ full: params.full === true });
  }
}

let closing = false;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await indexer.cancel();
  } catch (err) {
    console.error(`[lsp-viz] indexer cancel failed: ${errorMessage(err)}`);
  }
  try {
    store.close();
  } catch (err) {
    console.error(`[lsp-viz] store close failed: ${errorMessage(err)}`);
  }
  process.exit(0);
}

port.on('message', (event) => {
  const request = event.data as WorkerRequest;
  if (request.type === 'shutdown') {
    void shutdown();
    return;
  }
  if (request.type === 'index') {
    api.startIndexRun(request.mode);
    return;
  }
  void dispatch(request).then(
    (value) => send({ type: 'reply', id: request.id, reply: { ok: true, value } }),
    (err: unknown) => {
      const status = err instanceof ApiRouteError ? err.status : 500;
      send({
        type: 'reply',
        id: request.id,
        reply: { ok: false, status, error: errorMessage(err) },
      });
    },
  );
});

send({ type: 'ready', repoRoot, dbPath });

// Mirrors the CLI: a repo that has never been indexed starts indexing on open,
// and the UI stays usable while the structural layer lands.
if (store.getMeta('indexedAt') === null) {
  api.startIndexRun('full');
}
