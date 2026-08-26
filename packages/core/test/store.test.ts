import { beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store.js';
import { edgeId } from '../src/ids.js';
import { ROOT_NODE_ID } from '../src/types.js';
import type { GraphEdge, GraphNode, NodeKind } from '../src/types.js';

function node(
  id: string,
  kind: NodeKind,
  name: string,
  path: string,
  parentId: string | null,
): GraphNode {
  return { id, kind, name, path, parentId, language: 'typescript' };
}

function edge(kind: GraphEdge['kind'], from: string, to: string, sourcePath?: string): GraphEdge {
  const e: GraphEdge = { id: edgeId(kind, from, to), kind, from, to, count: 1 };
  if (sourcePath) e.sourcePath = sourcePath;
  return e;
}

/**
 * root
 *  ├─ pkgA (packages/a)
 *  │   ├─ srcA (packages/a/src)
 *  │   │   ├─ fileA1 (a1.ts): fnFoo, clsC { mBar }
 *  │   │   └─ fileA2 (a2.ts): fnBaz
 *  │   └─ fileIdx (index.ts): fnMain
 *  └─ pkgB (packages/b)
 *      └─ fileB1 (util.ts): fnUtil
 */
function seed(store: GraphStore): void {
  store.upsertNodes([
    node(ROOT_NODE_ID, 'workspace', 'demo', '', null),
    node('pkgA', 'package', 'a', 'packages/a', ROOT_NODE_ID),
    node('pkgB', 'package', 'b', 'packages/b', ROOT_NODE_ID),
    node('srcA', 'directory', 'src', 'packages/a/src', 'pkgA'),
    node('fileA1', 'file', 'a1.ts', 'packages/a/src/a1.ts', 'srcA'),
    node('fileA2', 'file', 'a2.ts', 'packages/a/src/a2.ts', 'srcA'),
    node('fileIdx', 'file', 'index.ts', 'packages/a/index.ts', 'pkgA'),
    node('fileB1', 'file', 'util.ts', 'packages/b/util.ts', 'pkgB'),
    node('fnFoo', 'function', 'foo', 'packages/a/src/a1.ts', 'fileA1'),
    node('clsC', 'class', 'C', 'packages/a/src/a1.ts', 'fileA1'),
    node('mBar', 'method', 'bar', 'packages/a/src/a1.ts', 'clsC'),
    node('fnBaz', 'function', 'baz', 'packages/a/src/a2.ts', 'fileA2'),
    node('fnMain', 'function', 'main', 'packages/a/index.ts', 'fileIdx'),
    node('fnUtil', 'function', 'util', 'packages/b/util.ts', 'fileB1'),
  ]);
  store.upsertEdges([
    edge('imports', 'fileA1', 'fileA2', 'packages/a/src/a1.ts'),
    edge('imports', 'fileIdx', 'fileA1', 'packages/a/index.ts'),
    edge('imports', 'fileA1', 'fileB1', 'packages/a/src/a1.ts'),
    edge('imports', 'fileA2', 'fileB1', 'packages/a/src/a2.ts'),
    edge('calls', 'fnFoo', 'fnBaz', 'packages/a/src/a1.ts'),
    edge('calls', 'mBar', 'fnFoo', 'packages/a/src/a1.ts'),
    edge('calls', 'fnFoo', 'fnUtil', 'packages/a/src/a1.ts'),
    edge('calls', 'fnMain', 'fnFoo', 'packages/a/index.ts'),
  ]);
  store.materializeAggregates();
}

describe('GraphStore', () => {
  let store: GraphStore;
  beforeEach(() => {
    store = new GraphStore(':memory:');
    seed(store);
  });

  it('round-trips nodes with ranges and attrs', () => {
    const n: GraphNode = {
      ...node('withRange', 'function', 'ranged', 'x.ts', 'fileA1'),
      range: { start: { line: 1, character: 0 }, end: { line: 4, character: 1 } },
      selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 15 } },
      signature: 'function ranged(): void',
      attrs: { loc: 4 },
    };
    store.upsertNodes([n]);
    expect(store.getNode('withRange')).toEqual(n);
  });

  it('root view shows packages with rolled-up import weights', () => {
    const view = store.getViewGraph(ROOT_NODE_ID);
    expect(view).toBeDefined();
    expect(view!.children.map((c) => c.id).sort()).toEqual(['pkgA', 'pkgB']);
    expect(view!.edges).toHaveLength(1);
    expect(view!.edges[0]).toMatchObject({ kind: 'imports', from: 'pkgA', to: 'pkgB', count: 2 });
  });

  it('package view mixes directory aggregates and direct files', () => {
    const view = store.getViewGraph('pkgA')!;
    expect(view.children.map((c) => c.id).sort()).toEqual(['fileIdx', 'srcA']);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ from: 'fileIdx', to: 'srcA', count: 1 });
  });

  it('directory view shows fine file-to-file imports only', () => {
    const view = store.getViewGraph('srcA')!;
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ kind: 'imports', from: 'fileA1', to: 'fileA2' });
  });

  it('file view remaps method calls to their class and surfaces portals', () => {
    const view = store.getViewGraph('fileA1')!;
    expect(view.children.map((c) => c.id).sort()).toEqual(['clsC', 'fnFoo']);
    // mBar -> fnFoo remapped to clsC -> fnFoo
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ kind: 'calls', from: 'clsC', to: 'fnFoo' });
    // portals: fnFoo -> fnBaz, fnFoo -> fnUtil (outgoing), fnMain -> fnFoo (incoming)
    const external = view.externalEdges.map((e) => `${e.from}->${e.to}`).sort();
    expect(external).toEqual(['fnFoo->fnBaz', 'fnFoo->fnUtil', 'fnMain->fnFoo']);
    expect(view.externalNodes.map((n) => n.id).sort()).toEqual(['fnBaz', 'fnMain', 'fnUtil']);
  });

  it('resolves import links for a file node', () => {
    const { incoming, outgoing } = store.getCalls('fileA1');
    expect(incoming.map((l) => l.node.id)).toEqual(['fileIdx']);
    expect(outgoing.map((l) => l.node.id).sort()).toEqual(['fileA2', 'fileB1']);
    expect(incoming[0]!.edge.kind).toBe('imports');
  });

  it('resolves incoming and outgoing calls for a symbol', () => {
    const { incoming, outgoing } = store.getCalls('fnFoo');
    expect(incoming.map((l) => l.node.id).sort()).toEqual(['fnMain', 'mBar']);
    expect(outgoing.map((l) => l.node.id).sort()).toEqual(['fnBaz', 'fnUtil']);
  });

  it('walks descendants transitively, including symbols nested in a class', () => {
    const fileIds = store.getDescendants('fileA1').map((n) => n.id).sort();
    expect(fileIds).toEqual(['clsC', 'fnFoo', 'mBar']);
    expect(store.getDescendants('clsC').map((n) => n.id)).toEqual(['mBar']);
  });

  it('walks ancestors root-first', () => {
    expect(store.getAncestors('mBar').map((n) => n.id)).toEqual([
      ROOT_NODE_ID,
      'pkgA',
      'srcA',
      'fileA1',
      'clsC',
    ]);
  });

  it('materializes symbolCount attrs on containers and files', () => {
    expect(store.getNode(ROOT_NODE_ID)!.attrs?.symbolCount).toBe(13);
    expect(store.getNode('fileA1')!.attrs?.symbolCount).toBe(3);
    expect(store.getNode('pkgB')!.attrs?.symbolCount).toBe(2);
  });

  it('search prefilters by name and path, excluding the workspace node', () => {
    const byName = store.searchCandidates('foo');
    expect(byName.map((n) => n.id)).toContain('fnFoo');
    const byPath = store.searchCandidates('packages/b');
    expect(byPath.map((n) => n.id).sort()).toEqual(['fileB1', 'fnUtil', 'pkgB']);
    expect(store.searchCandidates('demo').map((n) => n.id)).not.toContain(ROOT_NODE_ID);
  });

  it('escapes LIKE wildcards in search', () => {
    expect(store.searchCandidates('%').length).toBe(0);
  });

  it('accumulates weight through addEdge', () => {
    store.addEdge('calls', 'fnFoo', 'fnBaz', 1, 'packages/a/src/a1.ts');
    const { outgoing } = store.getCalls('fnFoo');
    const toBaz = outgoing.find((l) => l.node.id === 'fnBaz')!;
    expect(toBaz.edge.count).toBe(2);
  });

  it('deletes all data derived from one file, keeping containers', () => {
    store.deleteFileData('packages/a/src/a1.ts');
    expect(store.getNode('fileA1')).toBeUndefined();
    expect(store.getNode('fnFoo')).toBeUndefined();
    expect(store.getNode('mBar')).toBeUndefined();
    expect(store.getNode('srcA')).toBeDefined();
    // edges produced by a1.ts are gone; edges from other files remain
    expect(store.getCalls('fnUtil').incoming).toHaveLength(0);
    const { incoming } = store.getCalls('fnFoo');
    expect(incoming.map((l) => l.node.id)).toEqual(['fnMain']);
  });

  it('round-trips file records', () => {
    store.upsertFileRecord({
      path: 'packages/a/src/a1.ts',
      mtimeMs: 123456,
      size: 42,
      structuralDone: true,
      semanticDone: false,
    });
    const rec = store.getFileRecord('packages/a/src/a1.ts')!;
    expect(rec.structuralDone).toBe(true);
    expect(rec.semanticDone).toBe(false);
    expect(store.listFileRecords()).toHaveLength(1);
  });

  it('reports stats', () => {
    const stats = store.stats();
    expect(stats.nodes).toBe(14);
    expect(stats.edges).toBe(8);
    expect(stats.aggregateEdges).toBeGreaterThan(0);
  });

  it('persists and reads meta', () => {
    store.setMeta('repoRoot', '/tmp/demo');
    expect(store.getMeta('repoRoot')).toBe('/tmp/demo');
    expect(store.getMeta('missing')).toBeNull();
  });

  it('garbage-collects containers left empty by file deletion, up the chain', () => {
    // pkgB has a single file; removing it must sweep pkgB but keep root.
    store.deleteFileData('packages/b/util.ts');
    const removed = store.gcEmptyContainers();
    expect(removed).toBeGreaterThan(0);
    expect(store.getNode('pkgB')).toBeUndefined();
    expect(store.getNode(ROOT_NODE_ID)).toBeDefined();
    expect(store.getNode('srcA')).toBeDefined();
  });

  it('prunes edges left dangling by symbol removal, keeping live ones', () => {
    // Remove a1.ts (and with it fnFoo); fnMain -> fnFoo from index.ts dangles.
    store.deleteFileData('packages/a/src/a1.ts');
    const pruned = store.pruneDanglingEdges();
    expect(pruned).toBeGreaterThan(0);
    expect(store.getCalls('fnMain').outgoing).toHaveLength(0);
    // Live edge untouched: imports index.ts -> a1? gone too (a1 deleted); check
    // an edge between surviving nodes instead.
    expect(store.getEdgesTouching(['fileA2'], ['imports']).length).toBeGreaterThan(0);
  });

  it('round-trips pending calls and clears them per source file', () => {
    store.addPendingCalls([
      {
        fromId: 'fnMain',
        toPath: 'packages/b/util.ts',
        selLine: 3,
        selChar: 9,
        count: 2,
        sourcePath: 'packages/a/index.ts',
      },
      {
        fromId: 'fnBaz',
        toPath: 'packages/b/util.ts',
        selLine: 3,
        selChar: 9,
        count: 1,
        sourcePath: 'packages/a/src/a2.ts',
      },
    ]);
    expect(store.listPendingCalls()).toHaveLength(2);

    store.deleteFileData('packages/a/index.ts');
    const rest = store.listPendingCalls();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.fromId).toBe('fnBaz');

    store.deletePendingCalls([rest[0]!.id]);
    expect(store.listPendingCalls()).toHaveLength(0);
  });
});
