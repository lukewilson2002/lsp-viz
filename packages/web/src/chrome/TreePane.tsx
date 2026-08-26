/**
 * Files tab — the repo's directory tree from GET /api/tree (cached in the
 * store, refetched on index:done). Every row navigates.
 *
 * Two highlights coexist, because they answer different questions. The CURRENT
 * VIEW row ("where am I looking") is quiet — an elevated background plus a left
 * rail. The SELECTION row ("what did I click") is loud — accent-tinted, per the
 * brief's rule that accent is reserved for selection/hits/hover. When the
 * selection is a symbol the tree has no row for, its declaring file stands in
 * and carries a trailing chip naming the symbol, so `index.ts` never looks
 * selected when a function inside it is.
 */

import type { GraphNode, TreeNode } from '@lsp-viz/core';
import { useEffect, useRef, useState } from 'react';
import { kindGlyph } from '../canvas/glyphs';
import { useAppStore } from '../state/store';
import { useTreeAnchor } from './treeAnchor';

export function TreePane({
  selectionId,
  visible,
}: {
  /** The node backing the Details tab, or null when nothing is selected. */
  selectionId: string | null;
  /** False while the Details tab is showing — scrollIntoView is a no-op then. */
  visible: boolean;
}) {
  const tree = useAppStore((s) => s.tree);
  const treeError = useAppStore((s) => s.treeError);
  const ensureTree = useAppStore((s) => s.ensureTree);
  const topId = useAppStore((s) => s.stack[s.stack.length - 1]?.nodeId ?? null);

  useEffect(() => {
    if (tree === null) void ensureTree();
  }, [tree, ensureTree]);

  const viewAnchor = useTreeAnchor(topId);
  const selAnchor = useTreeAnchor(selectionId);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Auto-expand both chains when the tree opens, the view changes or the
  // selection moves. Never auto-collapses what the user opened.
  useEffect(() => {
    const chains = [viewAnchor?.chain, selAnchor?.chain].filter(
      (chain): chain is TreeNode[] => chain !== undefined,
    );
    if (chains.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const chain of chains) {
        for (const node of chain) {
          if (node.children) next.add(node.id);
        }
      }
      return next;
    });
  }, [viewAnchor, selAnchor]);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Exactly one row scrolls, and the selection wins — it is the thing that
  // just changed.
  const scrollTargetId = selAnchor?.id ?? viewAnchor?.id ?? null;

  return (
    <div className="sidebar-tree">
      {treeError !== null ? <div className="sidebar-placeholder">{treeError}</div> : null}
      {tree === null && treeError === null ? (
        <div className="sidebar-placeholder">
          <span className="spinner" aria-hidden />
        </div>
      ) : null}
      {tree !== null ? (
        <TreeRow
          node={tree}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          currentId={viewAnchor?.id ?? null}
          selectedId={selAnchor?.id ?? null}
          proxyTarget={selAnchor?.proxy === true ? selAnchor.target : null}
          scrollTargetId={scrollTargetId}
          visible={visible}
        />
      ) : null}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  currentId: string | null;
  selectedId: string | null;
  proxyTarget: GraphNode | null;
  scrollTargetId: string | null;
  visible: boolean;
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, expanded, onToggle, currentId, selectedId, proxyTarget } = props;
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const isDir = node.children !== undefined;
  const open = expanded.has(node.id);
  const isCurrent = node.id === currentId;
  const isSelected = node.id === selectedId;
  const proxy = isSelected && proxyTarget !== null;
  const isScrollTarget = node.id === props.scrollTargetId;
  const { visible } = props;
  const rowRef = useRef<HTMLButtonElement>(null);

  // scrollIntoView inside a `hidden` subtree does nothing, so re-run it the
  // moment the Files tab becomes visible again.
  useEffect(() => {
    if (isScrollTarget && visible) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isScrollTarget, visible]);

  const className = [
    'tree-row',
    isCurrent ? 'tree-row--current' : '',
    isSelected ? 'tree-row--selected' : '',
    proxy ? 'tree-row--proxy' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="tree-node">
      <button
        ref={rowRef}
        className={className}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => void navigateToNode(node.id)}
        title={node.path === '' ? node.name : node.path}
      >
        {isDir ? (
          <span
            className="tree-chevron"
            role="button"
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.id);
            }}
          >
            {open ? '▾' : '▸'}
          </span>
        ) : (
          <span className="tree-chevron tree-chevron--leaf" aria-hidden />
        )}
        <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
          {kindGlyph(node.kind)}
        </span>
        <span className="tree-name">{node.name}</span>
        {proxy && proxyTarget ? (
          <span
            className="tree-proxy-chip"
            role="button"
            tabIndex={0}
            title={`${proxyTarget.name} is selected — open its details`}
            onClick={(event) => {
              event.stopPropagation();
              setSidebarTab('details');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.stopPropagation();
              event.preventDefault();
              setSidebarTab('details');
            }}
          >
            <span className={`kind-glyph kind-glyph--${proxyTarget.kind}`} aria-hidden>
              {kindGlyph(proxyTarget.kind)}
            </span>
            {proxyTarget.name}
          </span>
        ) : null}
      </button>
      {isDir && open
        ? node.children?.map((child) => (
            <TreeRow key={child.id} {...props} node={child} depth={depth + 1} />
          ))
        : null}
    </div>
  );
}
