#!/usr/bin/env node
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import openBrowser from 'open';
import { GraphStore, repoHash } from '@lsp-viz/core';
import { createIndexer } from '@lsp-viz/indexer';
import type { IndexProgressEvent, Indexer } from '@lsp-viz/indexer';
import { buildServer } from './server.js';

interface CliOptions {
  port: string;
  open: boolean;
  db?: string;
  reindex: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(repoArg: string, options: CliOptions): Promise<void> {
  const repoRoot = path.resolve(repoArg);
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    console.error(`[lsp-viz] not a directory: ${repoRoot}`);
    process.exit(1);
  }

  const port = Number.parseInt(options.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[lsp-viz] invalid port: ${options.port}`);
    process.exit(1);
  }

  const dbPath = options.db
    ? path.resolve(options.db)
    : path.join(homedir(), '.cache', 'lsp-viz', `${repoHash(repoRoot)}.db`);
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new GraphStore(dbPath);

  // Progress events flow indexer -> forward -> server broadcast; `forward` is
  // rebound once the server exists.
  let forward: (event: IndexProgressEvent) => void = () => {};
  let indexer: Indexer;
  try {
    indexer = createIndexer({
      repoRoot,
      store,
      onProgress: (event) => forward(event),
    });
  } catch (err) {
    // A broken indexer must not prevent serving an already-built database.
    const message = errorMessage(err);
    console.error(`[lsp-viz] failed to create indexer: ${message}`);
    indexer = {
      run: () => Promise.reject(new Error(`indexer unavailable: ${message}`)),
      cancel: () => Promise.resolve(),
      running: false,
    };
  }

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const app = await buildServer({ store, indexer, repoRoot, webDist });
  forward = (event) => app.broadcastIndexEvent(event);

  let url: string;
  try {
    url = await app.listen({ port, host: '127.0.0.1' });
  } catch (err) {
    console.error(`[lsp-viz] failed to listen on 127.0.0.1:${port}: ${errorMessage(err)}`);
    store.close();
    process.exit(1);
  }
  console.log(`[lsp-viz] serving ${url} — repo ${repoRoot} — db ${dbPath}`);

  if (options.reindex || store.getMeta('indexedAt') === null) {
    console.log('[lsp-viz] starting full index in the background');
    app.startIndexRun('full');
  }

  if (options.open) {
    try {
      await openBrowser(url);
    } catch (err) {
      console.warn(`[lsp-viz] could not open the browser: ${errorMessage(err)}`);
    }
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      // Graceful shutdown can hang if the language server wedges without
      // exiting (cancel awaits the in-flight run) — a second signal must
      // always win.
      console.log('\n[lsp-viz] forced exit');
      process.exit(130);
    }
    shuttingDown = true;
    console.log('\n[lsp-viz] shutting down (press Ctrl-C again to force)');
    void (async () => {
      try {
        await indexer.cancel();
      } catch (err) {
        console.error(`[lsp-viz] indexer cancel failed: ${errorMessage(err)}`);
      }
      try {
        await app.close();
      } catch (err) {
        console.error(`[lsp-viz] server close failed: ${errorMessage(err)}`);
      }
      try {
        store.close();
      } catch (err) {
        console.error(`[lsp-viz] store close failed: ${errorMessage(err)}`);
      }
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const program = new Command();

program
  .name('lsp-viz')
  .description('Visual codebase explorer — index a repository and serve the interactive graph')
  .argument('<repo>', 'path to the repository to explore')
  .option('-p, --port <port>', 'port to listen on', '4977')
  .option('--no-open', 'do not open the browser')
  .option('--db <path>', 'SQLite database path (default: ~/.cache/lsp-viz/<repo-hash>.db)')
  .option('--reindex', 'force a full re-index on startup', false)
  .action(async (repo: string, options: CliOptions) => {
    await main(repo, options);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`[lsp-viz] fatal: ${errorMessage(err)}`);
  process.exit(1);
});
