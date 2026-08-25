/**
 * Sidebar width: user-resizable via the drag handle, persisted across
 * sessions. Applied as the `--sidebar-width` CSS custom property, which both
 * the sidebar itself and the canvas's right offset read — so dragging never
 * needs a React re-render, just a style write.
 */

const STORAGE_KEY = 'lsp-viz.sidebarWidth';

export const MIN_SIDEBAR_WIDTH = 300;
export const MAX_SIDEBAR_WIDTH = 900;
/** Never let the sidebar crowd the canvas out entirely. */
const MIN_CANVAS_WIDTH = 320;

export function clampSidebarWidth(width: number): number {
  const viewportCap = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - MIN_CANVAS_WIDTH);
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.min(MAX_SIDEBAR_WIDTH, viewportCap));
}

/** The persisted width, if the user has ever dragged the handle. */
export function loadSidebarWidth(): number | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampSidebarWidth(n) : null;
}

export function saveSidebarWidth(width: number): void {
  window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
}

export function clearSidebarWidth(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function applySidebarWidth(width: number | null): void {
  const root = document.documentElement.style;
  if (width === null) {
    root.removeProperty('--sidebar-width');
  } else {
    root.setProperty('--sidebar-width', `${width}px`);
  }
}
