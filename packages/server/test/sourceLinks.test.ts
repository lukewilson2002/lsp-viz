/**
 * GET /api/links/:id — which identifiers a source slice is allowed to link.
 *
 * The failure this pins down is silent and total: a FILE node's own edges are
 * file-to-file `imports`, so the only names the client could ever derive are
 * basenames like `index.ts`. Every file source view in the app had zero links.
 *
 * The other half is trust. A link that jumps to the WRONG declaration is worse
 * than no link — there is no undo but Back — so the tiering (own links > own
 * file > imported files, one hop through a barrel) and the ambiguity rule
 * (a name owned by two declarations in the same tier is dropped, not guessed)
 * are the behaviour under test, not an implementation detail.
 */

import { GraphStore, ROOT_NODE_ID, edgeId } from '@lsp-viz/core';
import type { GraphEdge, GraphNode, NodeKind, SourceLinksResponse } from '@lsp-viz/core';
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

function edge(kind: GraphEdge['kind'], from: string, to: string): GraphEdge {
  return { id: edgeId(kind, from, to), kind, from, to, count: 1, sourcePath: 'x' };
}

/**
 * root
 *  ├ @demo/text  packages/text/src
 *  │   ├ index.ts    barrel: declares NOTHING, imports format.ts + slug.ts
 *  │   ├ format.ts   DEFAULT_WIDTH, padCell (local `width`), formatRow
 *  │   └ slug.ts     slugify
 *  ├ @demo/dup   packages/dup/src
 *  │   └ slug.ts     slugify  ← same name, different node
 *  └ @demo/app   packages/app/src
 *      ├ report.ts   buildReport (local `rows`), formatRow  ← shadows text's
 *      │             imports text/index.ts (barrel) and dup/src/slug.ts
 *      └ solo.ts     lonely
 */
function seed(store: GraphStore): void {
  store.upsertNodes([
    node(ROOT_NODE_ID, 'workspace', 'demo', '', null),
    node('pkgText', 'package', '@demo/text', 'packages/text', ROOT_NODE_ID),
    node('srcText', 'directory', 'src', 'packages/text/src', 'pkgText'),
    node('textIndex', 'file', 'index.ts', 'packages/text/src/index.ts', 'srcText'),
    node('format', 'file', 'format.ts', 'packages/text/src/format.ts', 'srcText'),
    node('DEFAULT_WIDTH', 'variable', 'DEFAULT_WIDTH', 'packages/text/src/format.ts', 'format'),
    node('padCell', 'function', 'padCell', 'packages/text/src/format.ts', 'format'),
    node('padCellWidth', 'variable', 'width', 'packages/text/src/format.ts', 'padCell'),
    node('formatRow', 'function', 'formatRow', 'packages/text/src/format.ts', 'format'),
    node('textSlug', 'file', 'slug.ts', 'packages/text/src/slug.ts', 'srcText'),
    node('textSlugify', 'function', 'slugify', 'packages/text/src/slug.ts', 'textSlug'),

    node('pkgDup', 'package', '@demo/dup', 'packages/dup', ROOT_NODE_ID),
    node('srcDup', 'directory', 'src', 'packages/dup/src', 'pkgDup'),
    node('dupSlug', 'file', 'slug.ts', 'packages/dup/src/slug.ts', 'srcDup'),
    node('dupSlugify', 'function', 'slugify', 'packages/dup/src/slug.ts', 'dupSlug'),

    node('pkgApp', 'package', '@demo/app', 'packages/app', ROOT_NODE_ID),
    node('srcApp', 'directory', 'src', 'packages/app/src', 'pkgApp'),
    node('report', 'file', 'report.ts', 'packages/app/src/report.ts', 'srcApp'),
    node('buildReport', 'function', 'buildReport', 'packages/app/src/report.ts', 'report'),
    node('reportRows', 'variable', 'rows', 'packages/app/src/report.ts', 'buildReport'),
    node('reportFormatRow', 'function', 'formatRow', 'packages/app/src/report.ts', 'report'),
    node('solo', 'file', 'solo.ts', 'packages/app/src/solo.ts', 'srcApp'),
    node('lonely', 'function', 'lonely', 'packages/app/src/solo.ts', 'solo'),
  ]);
  store.upsertEdges([
    edge('imports', 'textIndex', 'format'),
    edge('imports', 'textIndex', 'textSlug'),
    edge('imports', 'report', 'textIndex'),
    edge('imports', 'report', 'dupSlug'),
    edge('calls', 'padCell', 'formatRow'),
    edge('references', 'padCell', 'DEFAULT_WIDTH'),
  ]);
  store.materializeAggregates();
}

const stubIndexer: Indexer = {
  run: async (): Promise<IndexStats> => ({ files: 0, nodes: 0, edges: 0, durationMs: 0 }),
  cancel: async () => undefined,
  running: false,
};

describe('GET /api/links/:id — clickable identifiers for a source slice', () => {
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

  const links = async (id: string): Promise<Map<string, string>> => {
    const res = await app.inject({ method: 'GET', url: `/api/links/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<SourceLinksResponse>();
    expect(body.nodeId).toBe(id);
    // The client's first-wins name lookup is only safe because of this.
    expect(new Set(body.links.map((l) => l.name)).size).toBe(body.links.length);
    return new Map(body.links.map((l) => [l.name, l.nodeId]));
  };

  it('gives a FILE node its own and its imports’ declarations', async () => {
    const byName = await links('format');
    expect([...byName.keys()].sort()).toEqual(['DEFAULT_WIDTH', 'formatRow', 'padCell']);
    expect(byName.get('DEFAULT_WIDTH')).toBe('DEFAULT_WIDTH');
  });

  it('resolves through a barrel that declares nothing itself', async () => {
    // report.ts imports packages/text/src/index.ts, which re-exports only.
    const byName = await links('report');
    expect(byName.get('DEFAULT_WIDTH')).toBe('DEFAULT_WIDTH');
    expect(byName.get('padCell')).toBe('padCell');
  });

  it('never offers a file basename as an identifier', async () => {
    for (const id of ['report', 'format', 'textIndex']) {
      const byName = await links(id);
      expect([...byName.keys()].some((n) => n.includes('.'))).toBe(false);
      expect(byName.has('index')).toBe(false);
    }
  });

  it('lets a same-file declaration beat an imported one of the same name', async () => {
    // formatRow is declared in report.ts AND reachable through the barrel.
    expect((await links('report')).get('formatRow')).toBe('reportFormatRow');
  });

  it('drops a name owned by two declarations in the same tier', async () => {
    // slugify arrives twice at report.ts: via the barrel and via @demo/dup.
    expect((await links('report')).has('slugify')).toBe(false);
    // ...but is unambiguous one file over, where only one of them is in scope.
    expect((await links('textIndex')).get('slugify')).toBe('textSlugify');
  });

  it('excludes declarations nested inside another declaration', async () => {
    const report = await links('report');
    expect(report.has('rows')).toBe(false);
    expect((await links('format')).has('width')).toBe(false);
  });

  it("prefers a symbol's own resolved links over same-named candidates", async () => {
    // padCell references DEFAULT_WIDTH and calls formatRow — the LSP-resolved
    // facts, and the reason a referenced constant becomes clickable at all.
    const byName = await links('padCell');
    expect(byName.get('DEFAULT_WIDTH')).toBe('DEFAULT_WIDTH');
    expect(byName.get('formatRow')).toBe('formatRow');
    // Its own file's other declarations still come through, one tier down.
    expect(byName.get('padCell')).toBe('padCell');
  });

  it('answers a file with no links at all with an empty list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/links/solo' });
    expect(res.json<SourceLinksResponse>().links.map((l) => l.name)).toEqual(['lonely']);
  });

  it('answers containers (which have no source) with an empty list', async () => {
    for (const id of [ROOT_NODE_ID, 'pkgApp', 'srcApp']) {
      expect((await links(id)).size).toBe(0);
    }
  });

  it('404s an unknown node', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/links/nope' });
    expect(res.statusCode).toBe(404);
  });
});
