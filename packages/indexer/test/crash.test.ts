import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore, nodeId } from '@lsp-viz/core';
import { afterEach, describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../src/adapters/typescript.js';
import { createIndexer } from '../src/indexer.js';
import { LspClient, LspDeadError } from '../src/lsp/client.js';
import { semanticTestHooks } from '../src/semantic.js';

const repoRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

describe('LSP crash recovery', () => {
  afterEach(() => {
    semanticTestHooks.onFileDone = undefined;
  });

  it('client: SIGKILL rejects requests with LspDeadError, restart() recovers', async () => {
    const exits: Array<{ expected: boolean }> = [];
    const client = new LspClient(typescriptAdapter, repoRoot, {
      onExit: (info) => exits.push({ expected: info.expected }),
    });
    try {
      await client.start();
      const rel = 'packages/math/src/arithmetic.ts';
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      await client.openDocument(rel, text);
      const symbols = await client.documentSymbols(rel);
      expect(symbols).not.toBeNull();
      expect(symbols!.length).toBeGreaterThan(0);
      const firstGeneration = client.generation;

      // Hard-kill the child and wait for the exit to be observed.
      const pid = client.pid;
      expect(pid).toBeDefined();
      const exitSeen = new Promise<void>((resolve) => {
        const check = (): void => {
          if (exits.length > 0) resolve();
          else setTimeout(check, 25);
        };
        check();
      });
      process.kill(pid!, 'SIGKILL');
      await exitSeen;
      expect(client.alive).toBe(false);

      // Requests against the dead process reject cleanly (no hang).
      await expect(client.documentSymbols(rel)).rejects.toBeInstanceOf(LspDeadError);

      // Restart brings up a new generation that serves requests again.
      await client.restart();
      expect(client.generation).toBeGreaterThan(firstGeneration);
      expect(client.alive).toBe(true);
      await client.openDocument(rel, text);
      const symbolsAfter = await client.documentSymbols(rel);
      expect(symbolsAfter).not.toBeNull();
      expect(symbolsAfter!.length).toBeGreaterThan(0);
      expect(exits.some((e) => !e.expected)).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it('indexer: a full run survives SIGKILL of the language server mid-semantic', async () => {
    const store = new GraphStore(':memory:');
    let killedPid: number | undefined;
    semanticTestHooks.onFileDone = (_file, client) => {
      // Kill the child exactly once, right after the first file completes.
      if (killedPid === undefined && client.pid !== undefined) {
        killedPid = client.pid;
        process.kill(client.pid, 'SIGKILL');
      }
    };

    try {
      const indexer = createIndexer({ repoRoot, store });
      const stats = await indexer.run('full');
      console.log('[crash.test] stats after mid-run SIGKILL:', JSON.stringify(stats));

      expect(killedPid).toBeDefined();

      // Symbols from files processed after the crash must be present.
      const mean = store
        .getNodesByPath('packages/math/src/stats.ts')
        .find((n) => n.kind === 'function' && n.name === 'mean');
      expect(mean).toBeDefined();

      // Call edges from post-crash files as well.
      const varianceId = nodeId('packages/math/src/stats.ts', 'function', 'variance', null);
      const { outgoing } = store.getCalls(varianceId);
      expect(outgoing.some((l) => l.node.name === 'mean')).toBe(true);

      // The run completed: every file record is semanticDone (deterministic
      // ids make the retried file idempotent).
      const records = store.listFileRecords();
      expect(records.length).toBeGreaterThanOrEqual(10);
      expect(records.every((r) => r.semanticDone)).toBe(true);
      expect(store.getMeta('indexedAt')).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
