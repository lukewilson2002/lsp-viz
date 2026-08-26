/**
 * A container's links row must report what its CONTENTS touch across its own
 * boundary. `store.getCalls` answers containers from `aggregate_edges`, whose
 * rows only ever pair siblings under a shared parent — so a directory that is
 * the only child of its package has no sibling to pair with and reported
 * "0 in · 0 out" even when every file under it imported across the repo.
 *
 * That is the `packages/math/src` case from the fixture demo: nothing drawn,
 * nothing counted, while the files inside it were plainly wired to another
 * package.
 */

import { GraphStore, ROOT_NODE_ID, edgeId } from '@lsp-viz/core';
import type { GraphEdge, GraphNode, GraphViewResponse, NodeDetailResponse, NodeKind } from '@lsp-viz/core';
import type { IndexStats, Indexer } from '@lsp-viz/indexer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type { LspVizServer } from '../src/server.js';

function node(
  id: string,
  kind: NodeKind,
  name: string,
  path: string,
  parentId: string | null,
): GraphNode {
  return { id, kind, name, path, parentId, language: 'typescript' };
}

function edge(kind: GraphEdge['kind'], from: string, to: string, count = 1): GraphEdge {
  return { id: edgeId(kind, from, to), kind, from, to, count, sourcePath: 'packages/app/src/use.ts' };
}

/**
 * Mirrors the shape that exposed the bug — each package has exactly ONE
 * directory, so no aggregate_edges row ever names `mathSrc` or `appSrc`:
 *
 *   root
 *    ├─ mathPkg (packages/math) └─ mathSrc (packages/math/src) └─ vector.ts: Vector2, scale
 *    └─ appPkg  (packages/app)  └─ appSrc  (packages/app/src)  └─ use.ts: run
 *
 * use.ts imports vector.ts, and `run` both calls `scale` (×2) and references
 * `Vector2`. `scale → Vector2` stays inside math and must NOT surface.
 */
function seed(store: GraphStore): void {
  store.upsertNodes([
    node(ROOT_NODE_ID, 'workspace', 'demo', '', null),
    node('mathPkg', 'package', 'math', 'packages/math', ROOT_NODE_ID),
    node('mathSrc', 'directory', 'src', 'packages/math/src', 'mathPkg'),
    node('vectorFile', 'file', 'vector.ts', 'packages/math/src/vector.ts', 'mathSrc'),
    node('Vector2', 'class', 'Vector2', 'packages/math/src/vector.ts', 'vectorFile'),
    node('scale', 'function', 'scale', 'packages/math/src/vector.ts', 'vectorFile'),
    node('appPkg', 'package', 'app', 'packages/app', ROOT_NODE_ID),
    node('appSrc', 'directory', 'src', 'packages/app/src', 'appPkg'),
    node('useFile', 'file', 'use.ts', 'packages/app/src/use.ts', 'appSrc'),
    node('run', 'function', 'run', 'packages/app/src/use.ts', 'useFile'),
  ]);
  store.upsertEdges([
    edge('imports', 'useFile', 'vectorFile'),
    edge('calls', 'run', 'scale', 2),
    edge('references', 'run', 'Vector2'),
    edge('calls', 'scale', 'Vector2'),
  ]);
  store.materializeAggregates();
}

const stubIndexer: Indexer = {
  run: async (): Promise<IndexStats> => ({ files: 0, nodes: 0, edges: 0, durationMs: 0 }),
  cancel: async () => undefined,
  running: false,
};

describe('a container rolls up the links of everything inside it', () => {
  let store: GraphStore;
  let app: LspVizServer;

  beforeEach(async () => {
    store = new GraphStore(':memory:');
    seed(store);
    app = await buildServer({
      store,
      indexer: stubIndexer,
      repoRoot: process.cwd(),
      webDist: '/nonexistent-web-dist',
    });
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const detail = async (id: string): Promise<NodeDetailResponse> => {
    const res = await app.inject({ method: 'GET', url: `/api/node/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json<NodeDetailResponse>();
  };

  const view = async (parent: string): Promise<GraphViewResponse> => {
    const res = await app.inject({ method: 'GET', url: `/api/graph?parent=${parent}` });
    expect(res.statusCode).toBe(200);
    return res.json<GraphViewResponse>();
  };

  it('surfaces a lone directory\'s cross-package links, which aggregates never named', async () => {
    // The regression: aggregate_edges pairs siblings, and mathSrc has none.
    expect(store.getCalls('mathSrc')).toEqual({ incoming: [], outgoing: [] });

    const d = await detail('mathSrc');
    expect(
      d.incoming.map((l) => [l.node.id, l.edge.kind, l.edge.count]).sort(),
    ).toEqual([
      ['run', 'calls', 2],
      ['run', 'references', 1],
      ['useFile', 'imports', 1],
    ]);
    expect(d.outgoing).toEqual([]);
    expect(d.metrics).toMatchObject({ inCount: 3, outCount: 0 });
  });

  it('keeps links that stay inside the subtree out of the roll-up', async () => {
    // scale → Vector2 lives wholly within mathSrc, so it describes its insides.
    const d = await detail('mathSrc');
    const ids = [...d.incoming, ...d.outgoing].map((l) => l.node.id);
    expect(ids).not.toContain('Vector2');
    expect(ids).not.toContain('scale');
  });

  it('merges per (kind, far end) rather than collapsing distinct kinds', async () => {
    // run touches math twice over: a call (weight 2) and a reference. Same far
    // node, different meaning — two rows, not one of weight 3.
    const d = await detail('mathSrc');
    const fromRun = d.incoming.filter((l) => l.node.id === 'run');
    expect(fromRun.map((l) => l.edge.kind).sort()).toEqual(['calls', 'references']);
  });

  it('gives the outgoing side to the package that reaches out', async () => {
    const d = await detail('appSrc');
    expect(d.incoming).toEqual([]);
    expect(d.outgoing.map((l) => [l.node.id, l.edge.kind])).toEqual(
      expect.arrayContaining([
        ['vectorFile', 'imports'],
        ['scale', 'calls'],
        ['Vector2', 'references'],
      ]),
    );
  });

  it('counts the same set the card headlines on the view that draws it', async () => {
    const v = await view('mathPkg');
    const d = await detail('mathSrc');
    expect(v.linkCounts['mathSrc']).toEqual({
      inCount: d.incoming.length,
      outCount: d.outgoing.length,
    });
    // ...and that view draws no arrows at all: mathSrc is an only child, which
    // is exactly why the count had to come from somewhere other than the view.
    expect(v.edges).toEqual([]);
  });
});
