/**
 * The click half of a code link. Every surface that renders linkified code
 * (source slices, card/detail signatures) delegates on its container rather
 * than binding per anchor — the HTML is injected, so there are no React
 * elements to attach to.
 *
 * `stopPropagation` matters on the canvas: a signature link lives inside a
 * node card, and without it a click would also select (or, on the second
 * click, drill into) the card the user was navigating AWAY from.
 */

import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { useAppStore } from '../state/store';

export function useCodeLinkClick(): (event: MouseEvent<HTMLElement>) => void {
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('[data-node-id]');
      if (!(link instanceof HTMLElement)) return;
      const id = link.getAttribute('data-node-id');
      if (id === null || id === '') return;
      event.preventDefault();
      event.stopPropagation();
      void navigateToNode(id);
    },
    [navigateToNode],
  );
}
