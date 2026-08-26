/**
 * The one invariant behind a node card's links row: the "N in · M out" summary
 * and the list it expands to are THE SAME SET. The summary rides along on
 * /api/graph (`linkCounts`), the list comes from /api/node/:id — different
 * requests, so the server must derive both from one definition (`nodeLinks`).
 *
 * The interesting case is a class: its calls are recorded on its METHODS, and
 * a file view draws them as arrows out of the class card. A class that
 * headlines those arrows and then expands to "no links" is the bug these tests
 * pin down.
 */

import { GraphStore, ROOT_NODE_ID, edgeId } from '@lsp-viz/core';
import type {
  GraphEdge,
  GraphNode,
  GraphViewResponse,
  NodeDetailResponse,
  NodeKind,
} from '@lsp-viz/core';
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
  return { id: edgeId(kind, from, to), kind, from, to, count, sourcePath: 'packages/a/src/a1.ts' };
}

/**
 * root
 *  └─ pkgA (packages/a/src)
 *      ├─ a1.ts: class C { m1, m2 }, base B
 *      └─ a2.ts: helper, other
 *
 * C's members do all the calling: m1 → helper (×2), m2 → helper, m1 → m2
 * (internal), and other → m2. C itself only extends B.
 */
function seed(store: GraphStore): void {
  store.upsertNodes([
    node(ROOT_NODE_ID, 'workspace', 'demo', '', null),
    node('pkgA', 'package', 'a', 'packages/a', ROOT_NODE_ID),
    node('srcA', 'directory', 'src', 'packages/a/src', 'pkgA'),
    node('fileA1', 'file', 'a1.ts', 'packages/a/src/a1.ts', 'srcA'),
    node('fileA2', 'file', 'a2.ts', 'packages/a/src/a2.ts', 'srcA'),
    node('clsC', 'class', 'C', 'packages/a/src/a1.ts', 'fileA1'),
    node('m1', 'method', 'm1', 'packages/a/src/a1.ts', 'clsC'),
    node('m2', 'method', 'm2', 'packages/a/src/a1.ts', 'clsC'),
    node('clsB', 'class', 'B', 'packages/a/src/a1.ts', 'fileA1'),
    node('helper', 'function', 'helper', 'packages/a/src/a2.ts', 'fileA2'),
    node('other', 'function', 'other', 'packages/a/src/a2.ts', 'fileA2'),
  ]);
  store.upsertEdges([
    edge('extends', 'clsC', 'clsB'),
    edge('calls', 'm1', 'helper', 2),
    edge('calls', 'm2', 'helper'),
    edge('calls', 'm1', 'm2'),
    edge('calls', 'other', 'm2'),
  ]);
  store.materializeAggregates();
}

const stubIndexer: Indexer = {
  run: async (): Promise<IndexStats> => ({ files: 0, nodes: 0, edges: 0, durationMs: 0 }),
  cancel: async () => undefined,
  running: false,
};

describe("a node's links (GET /api/node/:id vs GET /api/graph linkCounts)", () => {
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

  it("rolls a class's member calls onto the class, merged per far end", async () => {
    const c = await detail('clsC');
    // m1 → helper (×2) and m2 → helper (×1) are ONE link of weight 3; m1 → m2
    // never leaves the class, so it is not a link of the class at all.
    expect(c.outgoing.map((l) => [l.node.id, l.edge.kind, l.edge.count])).toEqual([
      ['clsB', 'extends', 1],
      ['helper', 'calls', 3],
    ]);
    expect(c.incoming.map((l) => [l.node.id, l.edge.count])).toEqual([['other', 1]]);
    expect(c.metrics).toMatchObject({ inCount: 1, outCount: 2 });
  });

  it('reports the same counts on the view that draws the class card', async () => {
    const v = await view('fileA1');
    const c = await detail('clsC');
    expect(v.linkCounts['clsC']).toEqual({
      inCount: c.incoming.length,
      outCount: c.outgoing.length,
    });
    // The drawn arrows are a different, view-local aggregation — the card's
    // summary must not be computed from them.
    expect(v.linkCounts['clsC']).not.toEqual({ inCount: 0, outCount: 0 });
  });

  it('counts every child of every view, and matches /api/node for each', async () => {
    for (const parent of [ROOT_NODE_ID, 'pkgA', 'srcA', 'fileA1', 'fileA2', 'clsC']) {
      const v = await view(parent);
      expect(Object.keys(v.linkCounts).sort()).toEqual(v.children.map((c) => c.id).sort());
      for (const child of v.children) {
        const d = await detail(child.id);
        expect({ parent, id: child.id, ...v.linkCounts[child.id] }).toEqual({
          parent,
          id: child.id,
          inCount: d.incoming.length,
          outCount: d.outgoing.length,
        });
        expect(d.metrics.inCount).toBe(d.incoming.length);
        expect(d.metrics.outCount).toBe(d.outgoing.length);
      }
    }
  });

  it('leaves leaf symbols, files and containers on their own edges', async () => {
    // A leaf symbol: its own call edges, one row per edge.
    const helper = await detail('helper');
    expect(helper.incoming.map((l) => [l.node.id, l.edge.count]).sort()).toEqual([
      ['m1', 2],
      ['m2', 1],
    ]);
    // A file: imports only (this fixture has none) — never its symbols' calls.
    expect(await detail('fileA1')).toMatchObject({ metrics: { inCount: 0, outCount: 0 } });
    // A container: aggregate roll-ups, which materializeAggregates built.
    const dir = await detail('srcA');
    expect(dir.metrics.childCount).toBe(2);
  });

  it('leaves a member-less class on its own edges', async () => {
    const b = await detail('clsB');
    expect(b.metrics).toMatchObject({ inCount: 1, outCount: 0 });
    const v = await view('fileA1');
    expect(v.linkCounts['clsB']).toEqual({ inCount: 1, outCount: 0 });
  });

  /**
   * `externalParents` is what lets the canvas roll several ghosts from one
   * neighbouring file into one. It must carry REAL nodes (the client selects
   * and drills into them by id) and must never offer a roll-up target that is
   * already drawn in the view — that would be a second card for one node.
   */
  describe('externalParents (portal roll-up targets)', () => {
    it('ships the declaring file of every external symbol', async () => {
      const v = await view('fileA1');
      // a1.ts reaches helper + other, both declared in a2.ts.
      expect(v.externalNodes.map((n) => n.id).sort()).toEqual(['helper', 'other']);
      expect(v.externalParents.map((n) => [n.id, n.kind])).toEqual([['fileA2', 'file']]);
    });

    it("omits the view's own ancestors", async () => {
      // In C's view the external symbols `helper`/`other` live in a2.ts, but
      // m1 also calls its sibling class B, declared in a1.ts — the file this
      // view is INSIDE. Rolling clsB onto a1.ts would point up the tree, not
      // sideways to a neighbour, so a1.ts is not offered as a target.
      store.upsertEdges([edge('calls', 'm1', 'clsB')]);
      const v = await view('clsC');
      expect(v.externalNodes.map((n) => n.id).sort()).toEqual(['clsB', 'helper', 'other']);
      expect(v.externalParents.map((n) => n.id)).toEqual(['fileA2']);
    });

    it('is empty when a view has no portals', async () => {
      expect((await view(ROOT_NODE_ID)).externalParents).toEqual([]);
    });
  });
});
