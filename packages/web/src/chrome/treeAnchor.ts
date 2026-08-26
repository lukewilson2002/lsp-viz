/**
 * Resolving a graph node id to a row in the sidebar's Files tree.
 *
 * The tree from GET /api/tree holds containers + files only, so a symbol (or a
 * class L4 view, or a portal target) has no row of its own. Rather than hide
 * those states the tree anchors them to their nearest tree-present ancestor and
 * flags the result as a PROXY, which lets the caller mark the standing-in row
 * and name the real target on it. Two anchors coexist: the current view's node
 * and the current selection.
 */

import type { GraphNode, TreeNode } from '@lsp-viz/core';
import { useEffect, useMemo } from 'react';
import { useAppStore } from '../state/store';

export interface TreeAnchor {
  /** The tree row to mark. */
  id: string;
  /** Root-to-anchor chain — the rows that must be expanded to reveal it. */
  chain: TreeNode[];
  /** True when `id` is a stand-in because the real node isn't in the tree. */
  proxy: boolean;
  /** The real node when `proxy` is true (a symbol, or a portal's target). */
  target: GraphNode | null;
}

/** Root-to-target chain of tree nodes for `id`, or null when absent. */
export function findChain(root: TreeNode, id: string): TreeNode[] | null {
  if (root.id === id) return [root];
  if (!root.children) return null;
  for (const child of root.children) {
    const sub = findChain(child, id);
    if (sub) return [root, ...sub];
  }
  return null;
}

/**
 * Anchor `id` in the cached tree. Returns null while the data needed to
 * resolve a proxy is still loading (the ancestor chain comes from
 * /api/node/:id, which this hook kicks off on demand).
 */
export function useTreeAnchor(id: string | null): TreeAnchor | null {
  const tree = useAppStore((s) => s.tree);
  const detail = useAppStore((s) => (id !== null ? (s.nodeDetails[id] ?? null) : null));
  const ensureNodeDetail = useAppStore((s) => s.ensureNodeDetail);

  const anchor = useMemo<TreeAnchor | null>(() => {
    if (tree === null || id === null) return null;
    const own = findChain(tree, id);
    if (own) return { id, chain: own, proxy: false, target: null };
    if (detail) {
      // ancestors = [root, ..., direct parent]; the deepest one that exists in
      // the tree is the closest honest stand-in.
      for (let i = detail.ancestors.length - 1; i >= 0; i -= 1) {
        const ancestor = detail.ancestors[i];
        if (!ancestor) continue;
        const chain = findChain(tree, ancestor.id);
        if (chain) return { id: ancestor.id, chain, proxy: true, target: detail.node };
      }
    }
    return null;
  }, [tree, id, detail]);

  useEffect(() => {
    if (tree !== null && id !== null && detail === null && findChain(tree, id) === null) {
      void ensureNodeDetail(id);
    }
  }, [tree, id, detail, ensureNodeDetail]);

  return anchor;
}
