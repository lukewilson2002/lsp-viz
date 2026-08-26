import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore, nodeId, ROOT_NODE_ID } from '@lsp-viz/core';
import type { GraphNode } from '@lsp-viz/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../src/adapters/typescript.js';
import { createIndexer } from '../src/indexer.js';
import { enclosingCardSymbol } from '../src/semantic.js';
import { fileNodeId } from '../src/structural.js';

const repoRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

const FORMAT = 'packages/text/src/format.ts';
const VECTOR = 'packages/math/src/vector.ts';
const CLI = 'packages/app/src/cli.ts';

const padCellId = nodeId(FORMAT, 'function', 'padCell', null);
const formatRowId = nodeId(FORMAT, 'function', 'formatRow', null);
const defaultWidthId = nodeId(FORMAT, 'variable', 'DEFAULT_WIDTH', null);

/** Hand-built node set shaped like a small file; no store, no language server. */
function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name'>): GraphNode {
  return {
    path: FORMAT,
    parentId: fileNodeId(FORMAT),
    language: 'typescript',
    ...partial,
  };
}

describe('enclosingCardSymbol', () => {
  const fileNode = node({
    id: fileNodeId(FORMAT),
    kind: 'file',
    name: 'format.ts',
    parentId: 'dir',
  });
  const constNode = node({
    id: 'const',
    kind: 'variable',
    name: 'DEFAULT_WIDTH',
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } },
  });
  const fn = node({
    id: 'fn',
    kind: 'function',
    name: 'formatRow',
    range: { start: { line: 5, character: 0 }, end: { line: 7, character: 1 } },
  });
  const callback = node({
    id: 'cb',
    kind: 'function',
    name: 'map() callback',
    parentId: 'fn',
    range: { start: { line: 6, character: 19 }, end: { line: 6, character: 47 } },
  });
  const cls = node({
    id: 'cls',
    kind: 'class',
    name: 'Vector2',
    path: VECTOR,
    range: { start: { line: 9, character: 0 }, end: { line: 20, character: 1 } },
  });
  const method = node({
    id: 'method',
    kind: 'method',
    name: 'plus',
    path: VECTOR,
    parentId: 'cls',
    range: { start: { line: 12, character: 2 }, end: { line: 14, character: 3 } },
  });
  const nodes = [fileNode, constNode, fn, callback, cls, method];

  it('climbs an inline callback up to the file-parented function', () => {
    expect(enclosingCardSymbol(nodes, { line: 6, character: 30 })?.id).toBe('fn');
  });

  it('stops at a method rather than swallowing it into its class', () => {
    expect(enclosingCardSymbol(nodes, { line: 13, character: 10 })?.id).toBe('method');
  });

  it('returns the const for a use inside a top-level initializer', () => {
    expect(enclosingCardSymbol(nodes, { line: 2, character: 20 })?.id).toBe('const');
  });

  it('returns null for an import specifier on line 0 (outside every symbol)', () => {
    expect(enclosingCardSymbol(nodes, { line: 0, character: 9 })).toBeNull();
  });

  it('returns null when the node set has no symbols at all', () => {
    expect(enclosingCardSymbol([fileNode], { line: 6, character: 30 })).toBeNull();
  });
});

describe('references edges over fixtures/demo-repo', () => {
  let store: GraphStore;

  beforeAll(async () => {
    store = new GraphStore(':memory:');
    await createIndexer({ repoRoot, store }).run('full');
  });

  afterAll(() => {
    store.close();
  });

  const allReferences = (): ReturnType<GraphStore['getEdgesTouching']> => {
    const ids = store.getDescendants(ROOT_NODE_ID).map((n) => n.id);
    return store.getEdgesTouching(ids, ['references']);
  };

  it('padCell references DEFAULT_WIDTH (the default parameter value)', () => {
    const { outgoing } = store.getCalls(padCellId);
    const link = outgoing.find((l) => l.node.id === defaultWidthId);
    expect(link, 'padCell -> DEFAULT_WIDTH').toBeDefined();
    expect(link!.edge.kind).toBe('references');
    expect(link!.edge.count).toBe(1);
    expect(link!.edge.sourcePath).toBe(FORMAT);
    expect(link!.node.name).toBe('DEFAULT_WIDTH');
  });

  it('DEFAULT_WIDTH is no longer stranded: 1 in, 0 out', () => {
    const { incoming, outgoing } = store.getCalls(defaultWidthId);
    expect(incoming.map((l) => l.node.id)).toEqual([padCellId]);
    expect(outgoing).toEqual([]);
  });

  it('emits exactly the five whole-fixture reference edges', () => {
    const rendered = allReferences()
      .map((e) => `${store.getNode(e.from)?.name}->${store.getNode(e.to)?.name}:${e.count}`)
      .sort();
    expect(rendered).toEqual([
      'Vector2->PointLike:1',
      'padCell->DEFAULT_WIDTH:1',
      'parseArgs->CliOptions:1',
      'plus->PointLike:1',
      'scale->Scalar:1',
    ]);
  });

  it('never duplicates an existing calls edge with a references edge', () => {
    const kinds = store
      .getCalls(formatRowId)
      .outgoing.filter((l) => l.node.id === padCellId)
      .map((l) => l.edge.kind);
    expect(kinds).toEqual(['calls']);

    // Whole-graph guard: no (from, to) pair carries both kinds.
    const ids = store.getDescendants(ROOT_NODE_ID).map((n) => n.id);
    const callPairs = new Set(
      store.getEdgesTouching(ids, ['calls']).map((e) => `${e.from}|${e.to}`),
    );
    expect(allReferences().filter((e) => callPairs.has(`${e.from}|${e.to}`))).toEqual([]);
  });

  it('keeps references symbol -> symbol: no file node is ever an endpoint', () => {
    for (const edge of allReferences()) {
      expect(store.getNode(edge.from)?.kind).not.toBe('file');
      expect(store.getNode(edge.to)?.kind).not.toBe('file');
    }
    // getCalls on a FILE node returns imports only; a references edge reaching
    // a file endpoint would draw a portal nothing counts.
    const fileLinks = store.getCalls(fileNodeId(FORMAT));
    const fileKinds = [...fileLinks.incoming, ...fileLinks.outgoing].map((l) => l.edge.kind);
    expect(fileKinds.length).toBeGreaterThan(0);
    expect(fileKinds.every((k) => k === 'imports')).toBe(true);
  });

  it('a cross-file reference is owned by the referrer, not the crawled file', () => {
    const cliOptions = allReferences().find((e) => store.getNode(e.to)?.name === 'CliOptions');
    expect(cliOptions!.sourcePath).toBe(CLI);
  });
});

describe('references survive a diff re-index without doubling', () => {
  it('re-sweeping a file whose edges were not deleted keeps count at 1', async () => {
    const store = new GraphStore(':memory:');
    try {
      const indexer = createIndexer({ repoRoot, store });
      await indexer.run('full');
      const before = store
        .getCalls(padCellId)
        .outgoing.find((l) => l.node.id === defaultWidthId);
      expect(before!.edge.count).toBe(1);

      // Touch the BARREL, not format.ts: format.ts's own file data (and with it
      // padCell -> DEFAULT_WIDTH) is never deleted, but the barrel's import
      // closure pulls format.ts back into the reference sweep. addEdge would
      // accumulate to 2 here; upsertEdges is absolute.
      const barrel = path.join(repoRoot, 'packages/text/src/index.ts');
      writeFileSync(barrel, readFileSync(barrel, 'utf8'));
      await indexer.run('diff');

      const after = store.getCalls(padCellId).outgoing.find((l) => l.node.id === defaultWidthId);
      expect(after, 'edge survives the diff run').toBeDefined();
      expect(after!.edge.count).toBe(1);
      expect(after!.edge.sourcePath).toBe(FORMAT);
    } finally {
      store.close();
    }
  }, 60_000);
});

/**
 * The languageId regression. A `.tsx` file opened as plain `typescript` is
 * parsed with JSX disabled, and documentSymbol then answers with the members
 * of that misparse — call expressions inside JSX become file-level `method`
 * symbols named after the callee, and the enclosing component's range is
 * truncated at the first `<`. Those pseudo-declarations are indistinguishable
 * from real ones downstream: they become L4 cards, they collect reference
 * edges aimed at the real symbol they are named after, and they outrank the
 * real declaration when a source identifier is turned into a link.
 */
describe('JSX files are parsed as JSX (adapter languageId)', () => {
  const ROW = 'packages/app/src/ui/Row.tsx';

  it('maps each dialect extension to its own LSP languageId', () => {
    const id = (p: string): string | undefined => typescriptAdapter.languageIdFor?.(p);
    expect(id('a/b.tsx')).toBe('typescriptreact');
    expect(id('a/b.jsx')).toBe('javascriptreact');
    expect(id('a/b.ts')).toBe('typescript');
    expect(id('a/b.mts')).toBe('typescript');
    expect(id('a/b.js')).toBe('javascript');
    expect(id('a/b.mjs')).toBe('javascript');
  });

  it('indexes a .tsx file to its real declarations only', async () => {
    const store = new GraphStore(':memory:');
    try {
      await createIndexer({ repoRoot, store }).run('full');
      const fileId = fileNodeId(ROW);
      const declarations = store
        .getChildren(fileId)
        .map((n) => `${n.kind} ${n.name}`)
        .sort();
      // Under the misparse this also contained `method glyph` (the JSX call
      // site) — a second, fake declaration of a function declared above it.
      expect(declarations).toEqual(['function Row', 'function glyph']);

      const row = store.getChildren(fileId).find((n) => n.name === 'Row');
      // The misparse truncated this at the first `<` (line 14).
      expect(row!.range!.end.line).toBeGreaterThan(16);

      // Exactly one `glyph` exists in the whole graph, and it is the real one.
      const glyphs = store
        .getDescendants(ROOT_NODE_ID)
        .filter((n) => n.name === 'glyph' && n.path === ROW);
      expect(glyphs.map((g) => g.kind)).toEqual(['function']);
    } finally {
      store.close();
    }
  }, 60_000);
});
