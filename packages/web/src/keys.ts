/**
 * App-wide keyboard handling. Per-canvas keys (arrows/Enter) live in
 * GraphCanvas where node positions are known; this module hosts the shared
 * guard plus the global Cmd/Ctrl-K + Escape hook.
 */

import { useEffect } from 'react';
import { selectTopEntry, useAppStore } from './state/store';

/** True when the event target is an input-like element (skip app shortcuts). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
}

/**
 * Global shortcuts: Cmd/Ctrl-K toggles the search palette (even while typing),
 * Escape closes the palette or clears the selection.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const state = useAppStore.getState();
        state.setPaletteOpen(!state.paletteOpen);
        return;
      }
      if (event.key === 'Escape') {
        // The palette input handles its own Escape (focus sits there); this
        // path covers Escape pressed anywhere else.
        if (isEditableTarget(event.target)) return;
        const state = useAppStore.getState();
        if (state.paletteOpen) {
          state.setPaletteOpen(false);
        } else if (selectTopEntry(state)?.selectionId) {
          state.select(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
