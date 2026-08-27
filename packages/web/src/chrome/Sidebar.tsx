/**
 * Right sidebar — always visible on canvas views (the L5 view has no sidebar),
 * width `--sidebar-width`, drag-to-resize on its left edge.
 *
 * Two tabs. FILES is the permanent structural browser: the repo tree from
 * GET /api/tree, with the current view and the current selection both marked.
 * DETAILS appears only while something is selected and carries everything
 * semantic about it (source, declarations, links). Selecting activates it;
 * clicking back to Files keeps the selection alive, so the two views coexist
 * instead of replacing each other.
 *
 * The rendered tab is DERIVED from the live selection rather than read raw
 * from the store, which is what makes every "nothing selected ⇒ Files" case
 * fall out for free: popstate rebuilds, the "+N more" cluster pseudo-selection,
 * Escape, and a pane click all go through selectionId and need no special case.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { isSyntheticNodeId } from '../canvas/types';
import type { SidebarTab } from '../state/store';
import { selectTopEntry, useAppStore } from '../state/store';
import { DetailsPane } from './DetailsPane';
import { SidebarTabs } from './SidebarTabs';
import { TreePane } from './TreePane';
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
  const storedTab = useAppStore((s) => s.sidebarTab);
  const resize = useSidebarResize();

  // The "+N more" cluster and the collapsed ghost are selections with no node
  // behind them, so they get no details tab. Deriving that here (rather than
  // special-casing it inside select()) keeps the store from having to know
  // about canvas internals.
  const detailsId = selectionId !== null && !isSyntheticNodeId(selectionId) ? selectionId : null;
  const tab: SidebarTab = detailsId === null ? 'files' : storedTab;

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
      <SidebarTabs tab={tab} detailsId={detailsId} />
      {/* Both panes stay mounted: unmounting the tree would drop its expansion
          state and scroll position, and re-run Shiki on every tab switch. */}
      <div className="sidebar-pane" role="tabpanel" hidden={tab !== 'files'}>
        <TreePane selectionId={detailsId} visible={tab === 'files'} />
      </div>
      {detailsId !== null ? (
        <div className="sidebar-pane" role="tabpanel" hidden={tab !== 'details'}>
          <DetailsPane key={detailsId} nodeId={detailsId} />
        </div>
      ) : null}
    </aside>
  );
}
