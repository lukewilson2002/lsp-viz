import { describe, expect, it } from 'vitest';
import { computeAggregates } from '../src/aggregate.js';
import type { AggregateInputEdge, AggregateInputNode } from '../src/aggregate.js';

// root -> pkgA -> srcA -> a1, a2
//      -> pkgB -> b1
const NODES: AggregateInputNode[] = [
  { id: 'root', parentId: null },
  { id: 'pkgA', parentId: 'root' },
  { id: 'pkgB', parentId: 'root' },
  { id: 'srcA', parentId: 'pkgA' },
  { id: 'a1', parentId: 'srcA' },
  { id: 'a2', parentId: 'srcA' },
  { id: 'idx', parentId: 'pkgA' },
  { id: 'b1', parentId: 'pkgB' },
];

function edge(from: string, to: string, count = 1): AggregateInputEdge {
  return { kind: 'imports', from, to, count };
}

describe('computeAggregates', () => {
  it('rolls a cross-package edge up to the package pair at the root view', () => {
    const rows = computeAggregates(NODES, [edge('a1', 'b1')]);
    expect(rows).toEqual([{ parentId: 'root', kind: 'imports', from: 'pkgA', to: 'pkgB', count: 1 }]);
  });

  it('sums weights of edges that map to the same pair', () => {
    const rows = computeAggregates(NODES, [edge('a1', 'b1', 2), edge('a2', 'b1', 3)]);
    expect(rows).toEqual([{ parentId: 'root', kind: 'imports', from: 'pkgA', to: 'pkgB', count: 5 }]);
  });

  it('skips edges whose endpoints are direct siblings (the fine edge already renders)', () => {
    expect(computeAggregates(NODES, [edge('a1', 'a2')])).toEqual([]);
  });

  it('maps mixed file/directory pairs inside a package', () => {
    const rows = computeAggregates(NODES, [edge('idx', 'a1')]);
    expect(rows).toEqual([{ parentId: 'pkgA', kind: 'imports', from: 'idx', to: 'srcA', count: 1 }]);
  });

  it('keeps directions distinct', () => {
    const rows = computeAggregates(NODES, [edge('a1', 'b1'), edge('b1', 'a2')]);
    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => `${r.from}->${r.to}`).sort();
    expect(pairs).toEqual(['pkgA->pkgB', 'pkgB->pkgA']);
  });

  it('ignores edges touching unknown nodes', () => {
    expect(computeAggregates(NODES, [edge('a1', 'ghost')])).toEqual([]);
  });

  it('ignores containment-crossing edges (one endpoint contains the other)', () => {
    expect(computeAggregates(NODES, [edge('pkgA', 'a1')])).toEqual([]);
  });

  it('survives parent cycles', () => {
    const cyclic: AggregateInputNode[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
      ...NODES,
    ];
    expect(computeAggregates(cyclic, [edge('x', 'a1')])).toEqual([]);
  });

  it('handles self edges', () => {
    expect(computeAggregates(NODES, [edge('a1', 'a1')])).toEqual([]);
  });
});
