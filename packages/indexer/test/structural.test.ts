import { fileURLToPath } from 'node:url';
import { GraphStore, ROOT_NODE_ID, nodeId } from '@lsp-viz/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIndexer } from '../src/indexer.js';
import type { IndexProgressEvent } from '../src/types.js';

const repoRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

describe('structural indexing of fixtures/demo-repo', () => {
  let store: GraphStore;
  const events: IndexProgressEvent[] = [];

  beforeAll(async () => {
    store = new GraphStore(':memory:');
    const indexer = createIndexer({
      repoRoot,
      store,
      onProgress: (e) => events.push(e),
    });
    await indexer.run('full');
  });

  afterAll(() => {
    store.close();
  });

  it('creates the root workspace node with exactly the 3 package children', () => {
    const root = store.getNode(ROOT_NODE_ID);
    expect(root?.kind).toBe('workspace');
    expect(root?.path).toBe('');

    const children = store.getChildren(ROOT_NODE_ID);
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.kind === 'package')).toBe(true);
    expect(children.map((c) => c.name).sort()).toEqual(['@demo/app', '@demo/math', '@demo/text']);
  });

  it('rolls imports up to aggregate package edges at the root view', () => {
    const appId = nodeId('packages/app', 'package', '@demo/app');
    const mathId = nodeId('packages/math', 'package', '@demo/math');
    const textId = nodeId('packages/text', 'package', '@demo/text');

    const view = store.getViewGraph(ROOT_NODE_ID);
    expect(view).toBeDefined();
    const importEdges = view!.edges.filter((e) => e.kind === 'imports');

    const appToMath = importEdges.find((e) => e.from === appId && e.to === mathId);
    const appToText = importEdges.find((e) => e.from === appId && e.to === textId);
    expect(appToMath, 'aggregate @demo/app -> @demo/math edge').toBeDefined();
    expect(appToText, 'aggregate @demo/app -> @demo/text edge').toBeDefined();
    expect(appToMath!.count).toBeGreaterThanOrEqual(2); // report.ts + stats.ts
    expect(appToText!.count).toBeGreaterThanOrEqual(2);
  });

  it('marks the app package main file as an entry point', () => {
    const fileNode = store
      .getNodesByPath('packages/app/src/main.ts')
      .find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.attrs?.entry).toBe(true);
  });

  it('records export summaries on file nodes', () => {
    const stats = store
      .getNodesByPath('packages/math/src/stats.ts')
      .find((n) => n.kind === 'file');
    expect(stats).toBeDefined();
    expect(stats!.attrs?.exportedNames).toContain('mean');
    expect(stats!.attrs?.exportCount).toBe(3);
    expect(stats!.attrs?.loc).toBeGreaterThan(10);
  });

  it('emitted phase, per-file progress, and done events', () => {
    expect(events.some((e) => e.type === 'phase' && e.phase === 'structural')).toBe(true);
    const progress = events.filter((e) => e.type === 'progress' && e.phase === 'structural');
    expect(progress.length).toBeGreaterThanOrEqual(10); // one per fixture source file
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('diff mode with no changes completes quickly and leaves the graph unchanged', async () => {
    const before = store.stats();
    const indexer = createIndexer({ repoRoot, store });
    const t0 = Date.now();
    await indexer.run('diff');
    expect(Date.now() - t0).toBeLessThan(3000);

    const after = store.stats();
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.files).toBe(before.files);
  });
});
