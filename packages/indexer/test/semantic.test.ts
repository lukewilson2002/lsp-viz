import { fileURLToPath } from 'node:url';
import { GraphStore, nodeId } from '@lsp-viz/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIndexer } from '../src/indexer.js';
import type { IndexProgressEvent } from '../src/types.js';

const repoRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

describe('semantic (LSP) indexing of fixtures/demo-repo', () => {
  let store: GraphStore;
  const events: IndexProgressEvent[] = [];

  beforeAll(async () => {
    store = new GraphStore(':memory:');
    const indexer = createIndexer({
      repoRoot,
      store,
      onProgress: (e) => events.push(e),
    });
    const stats = await indexer.run('full');
    console.log('[semantic.test] final stats:', JSON.stringify(stats));
  });

  afterAll(() => {
    store.close();
  });

  it('creates a function node for mean with a signature', () => {
    const mean = store
      .getNodesByPath('packages/math/src/stats.ts')
      .find((n) => n.kind === 'function' && n.name === 'mean');
    expect(mean).toBeDefined();
    expect(mean!.signature).toBeDefined();
    expect(mean!.signature).toContain('mean');
    // tsserver hovers this as a bare `function mean(...)`; the `export` is
    // read back from the source (see withSourceModifiers).
    expect(mean!.signature).toMatch(/^export function mean\b/);
    expect(mean!.range).toBeDefined();
    expect(mean!.selectionRange).toBeDefined();
    expect(mean!.attrs?.loc).toBeGreaterThan(1);
  });

  it('creates the Vector2 class with its method children', () => {
    const vector = store
      .getNodesByPath('packages/math/src/vector.ts')
      .find((n) => n.kind === 'class' && n.name === 'Vector2');
    expect(vector).toBeDefined();
    const methodNames = store
      .getChildren(vector!.id)
      .filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(methodNames).toEqual(expect.arrayContaining(['plus', 'scale', 'length']));
  });

  it('records same-file and cross-file calls edges from variance', () => {
    const varianceId = nodeId('packages/math/src/stats.ts', 'function', 'variance', null);
    const { outgoing } = store.getCalls(varianceId);
    const callTargets = outgoing.filter((l) => l.edge.kind === 'calls');

    const toMean = callTargets.find((l) => l.node.name === 'mean');
    expect(toMean, 'variance -> mean (same file)').toBeDefined();
    expect(toMean!.node.path).toBe('packages/math/src/stats.ts');
    expect(toMean!.edge.count).toBeGreaterThanOrEqual(2); // two call sites in variance

    const toSquare = callTargets.find((l) => l.node.name === 'square');
    expect(toSquare, 'variance -> square (cross file)').toBeDefined();
    expect(toSquare!.node.path).toBe('packages/math/src/arithmetic.ts');
  });

  it('records at least one cross-package calls edge from buildReport', () => {
    const buildReportId = nodeId(
      'packages/app/src/commands/report.ts',
      'function',
      'buildReport',
      null,
    );
    const { outgoing } = store.getCalls(buildReportId);
    const crossPackage = outgoing.filter(
      (l) =>
        l.edge.kind === 'calls' &&
        (l.node.path.startsWith('packages/math/') || l.node.path.startsWith('packages/text/')),
    );
    expect(crossPackage.length).toBeGreaterThan(0);
  });

  it('getViewGraph on the stats.ts file node returns portal (external) edges', () => {
    const fileNode = store
      .getNodesByPath('packages/math/src/stats.ts')
      .find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    const view = store.getViewGraph(fileNode!.id);
    expect(view).toBeDefined();
    expect(view!.children.length).toBeGreaterThanOrEqual(3); // mean, median, variance
    expect(view!.externalEdges.length).toBeGreaterThan(0);
    expect(view!.externalNodes.length).toBeGreaterThan(0);
    // Every external edge's far end resolves to a returned external node.
    const childIds = new Set(view!.children.map((c) => c.id));
    const externalIds = new Set(view!.externalNodes.map((n) => n.id));
    for (const edge of view!.externalEdges) {
      const farEnd = childIds.has(edge.from) ? edge.to : edge.from;
      expect(externalIds.has(farEnd)).toBe(true);
    }
  });

  it('emitted semantic phase + per-file progress events with running totals', () => {
    expect(events.some((e) => e.type === 'phase' && e.phase === 'semantic')).toBe(true);
    const progress = events.filter(
      (e): e is Extract<IndexProgressEvent, { type: 'progress' }> =>
        e.type === 'progress' && e.phase === 'semantic',
    );
    expect(progress.length).toBeGreaterThanOrEqual(10); // one per fixture source file
    const last = progress[progress.length - 1]!;
    expect(last.filesDone).toBe(last.filesTotal);
    expect(last.symbols).toBeGreaterThan(20);
    expect(last.callEdges).toBeGreaterThan(5);
  });

  it('marks every file record semanticDone', () => {
    const records = store.listFileRecords();
    expect(records.length).toBeGreaterThanOrEqual(10);
    expect(records.every((r) => r.semanticDone)).toBe(true);
    expect(records.every((r) => r.mtimeMs > 0 && r.size > 0)).toBe(true);
  });
});
