/**
 * Right sidebar — always visible on canvas views (the L5 view has no
 * sidebar), width `--sidebar-width`. Two modes:
 *
 * SOURCE (a node is selected, incl. portals): slim header (kind glyph, name,
 * kind chip, dimmed path) over full-height Shiki-highlighted source with real
 * line numbers and clickable callee-identifier links. Symbols show their
 * range, files the whole file. × / Escape deselects.
 *
 * TREE (no selection): collapsible directory tree of the repo from
 * GET /api/tree (cached in the store; refetched on index:done). Every row
 * navigates; the current view's node is highlighted, its ancestors
 * auto-expanded when the tree opens or the view changes.
 */

import type { SourceResponse, TreeNode } from '@lsp-viz/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { fetchSource } from '../api/client';
import { kindGlyph } from '../canvas/glyphs';
import { CLUSTER_NODE_ID } from '../canvas/types';
import type { CodeLink } from '../code/SourceView';
import { SourceView } from '../code/SourceView';
import { isContainerKind } from '../levels';
import { selectTopEntry, useAppStore } from '../state/store';
import {
  applySidebarWidth,
  clampSidebarWidth,
  clearSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from './sidebarWidth';

/** Drag-to-resize handle on the sidebar's left edge; double-click resets. */
function useSidebarResize(): {
  handleRef: (el: HTMLDivElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
} {
  const asideRef = useRef<HTMLElement | null>(null);
  const handleElRef = useRef<HTMLDivElement | null>(null);

  // Apply the persisted width once on mount; re-clamp (never re-widen) if the
  // window shrinks so the sidebar can't crowd the canvas out entirely.
  useEffect(() => {
    const stored = loadSidebarWidth();
    if (stored !== null) applySidebarWidth(stored);
    const onResize = (): void => {
      const current = loadSidebarWidth();
      if (current === null) return;
      const clamped = clampSidebarWidth(current);
      applySidebarWidth(clamped);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleRef = useCallback((el: HTMLDivElement | null) => {
    handleElRef.current = el;
    asideRef.current = el?.closest('.sidebar') ?? null;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const aside = asideRef.current;
    if (!aside) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');

    let latest = startWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      // Sidebar is right-anchored: dragging left (negative dx) widens it.
      const dx = moveEvent.clientX - startX;
      latest = clampSidebarWidth(startWidth - dx);
      applySidebarWidth(latest);
    };
    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      document.body.classList.remove('sidebar-resizing');
      saveSidebarWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }, []);

  const onDoubleClick = useCallback(() => {
    clearSidebarWidth();
    applySidebarWidth(null);
  }, []);

  return { handleRef, onPointerDown, onDoubleClick };
}

export function Sidebar() {
  const selectionId = useAppStore((s) => selectTopEntry(s)?.selectionId ?? null);
  const sourceMode = selectionId !== null && selectionId !== CLUSTER_NODE_ID;
  const resize = useSidebarResize();
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div
        ref={resize.handleRef}
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize · double-click to reset"
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
      {sourceMode && selectionId !== null ? (
        <SourcePane key={selectionId} nodeId={selectionId} />
      ) : (
        <TreePane />
      )}
    </aside>
  );
}

/* ------------------------------------------------------------- source mode */

function SourcePane({ nodeId }: { nodeId: string }) {
  const select = useAppStore((s) => s.select);
  const ensureNodeDetail = useAppStore((s) => s.ensureNodeDetail);
  const detail = useAppStore((s) => s.nodeDetails[nodeId] ?? null);

  const [source, setSource] = useState<SourceResponse | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setSourceMissing(false);
    void ensureNodeDetail(nodeId).then((loaded) => {
      if (cancelled) return;
      // Containers (workspace/package/directory) have no file behind them —
      // skip the request rather than provoking a 404 per selection.
      if (loaded && isContainerKind(loaded.node.kind)) {
        setSourceMissing(true);
        return;
      }
      fetchSource(nodeId)
        .then((src) => {
          if (!cancelled) setSource(src);
        })
        .catch(() => {
          if (!cancelled) setSourceMissing(true);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, ensureNodeDetail]);

  const links = useMemo<CodeLink[]>(
    () => detail?.outgoing.map((o) => ({ name: o.node.name, nodeId: o.node.id })) ?? [],
    [detail],
  );

  const node = detail?.node ?? null;

  return (
    <>
      <header className="sidebar-head">
        {node ? (
          <>
            <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
              {kindGlyph(node.kind)}
            </span>
            <span className="sidebar-name" title={node.name}>
              {node.name}
            </span>
            <span className="kind-badge">{node.kind}</span>
          </>
        ) : (
          <span className="sidebar-name">Loading…</span>
        )}
        <button
          className="sidebar-close"
          onClick={() => select(null)}
          title="Deselect (Escape)"
          aria-label="Deselect"
        >
          ×
        </button>
      </header>
      {node && node.path !== '' ? (
        <div className="sidebar-path" title={node.path}>
          {node.path}
          {source ? (
            <span className="sidebar-lines">
              {' '}
              · lines {source.startLine}–{source.endLine}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="sidebar-source">
        {source ? (
          <SourceView
            text={source.text}
            path={source.path}
            language={source.language}
            startLine={source.startLine}
            links={links}
          />
        ) : (
          <div className="sidebar-placeholder">
            {sourceMissing ? (
              'No source for this node — drill in to explore its contents.'
            ) : (
              <span className="spinner" aria-hidden />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- tree mode */

/** Root-to-target chain of tree nodes for `id`, or null when absent. */
function findChain(root: TreeNode, id: string): TreeNode[] | null {
  if (root.id === id) return [root];
  if (!root.children) return null;
  for (const child of root.children) {
    const sub = findChain(child, id);
    if (sub) return [root, ...sub];
  }
  return null;
}

function TreePane() {
  const tree = useAppStore((s) => s.tree);
  const treeError = useAppStore((s) => s.treeError);
  const ensureTree = useAppStore((s) => s.ensureTree);
  const ensureNodeDetail = useAppStore((s) => s.ensureNodeDetail);
  const topId = useAppStore((s) => selectTopEntry(s)?.nodeId ?? null);
  const topDetail = useAppStore((s) => (topId !== null ? s.nodeDetails[topId] ?? null : null));

  useEffect(() => {
    if (tree === null) void ensureTree();
  }, [tree, ensureTree]);

  // The row to highlight: the current view's node, or (for symbol/class views
  // whose nodes aren't in the containers+files tree) its deepest tree-present
  // ancestor, resolved from the cached node detail.
  const highlight = useMemo(() => {
    if (!tree || topId === null) return null;
    const own = findChain(tree, topId);
    if (own) return { id: topId, chain: own };
    if (topDetail) {
      for (let i = topDetail.ancestors.length - 1; i >= 0; i -= 1) {
        const ancestor = topDetail.ancestors[i];
        if (!ancestor) continue;
        const chain = findChain(tree, ancestor.id);
        if (chain) return { id: ancestor.id, chain };
      }
    }
    return null;
  }, [tree, topId, topDetail]);

  // Fetch the detail needed for ancestor resolution when the view node isn't
  // in the tree (e.g. a class L4 view).
  useEffect(() => {
    if (tree && topId !== null && topDetail === null && findChain(tree, topId) === null) {
      void ensureNodeDetail(topId);
    }
  }, [tree, topId, topDetail, ensureNodeDetail]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Auto-expand the current node's ancestors when the tree opens or the view
  // changes (never auto-collapse what the user opened).
  useEffect(() => {
    if (!highlight) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const node of highlight.chain) {
        if (node.children) next.add(node.id);
      }
      return next;
    });
  }, [highlight]);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <header className="sidebar-head sidebar-head--tree">
        <span className="sidebar-title">Files</span>
      </header>
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
            highlightId={highlight?.id ?? null}
          />
        ) : null}
      </div>
    </>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  highlightId,
}: {
  node: TreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  highlightId: string | null;
}) {
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  const isDir = node.children !== undefined;
  const open = expanded.has(node.id);
  const highlighted = node.id === highlightId;
  const rowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <div className="tree-node">
      <button
        ref={rowRef}
        className={`tree-row${highlighted ? ' tree-row--current' : ''}`}
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
      </button>
      {isDir && open
        ? node.children?.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              highlightId={highlightId}
            />
          ))
        : null}
    </div>
  );
}
