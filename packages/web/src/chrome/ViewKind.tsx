/**
 * What KIND of thing the canvas is currently showing the inside of.
 *
 * The breadcrumb above answers "where am I" with names; it does not say what
 * the last crumb IS, and the names alone are ambiguous — a directory, the file
 * inside it and the class inside that can all be called `hubCache`. Drilling a
 * few levels in, the canvas of cards looks much the same at every level, so
 * this names the current level outright.
 *
 * The word is the node's own `kind`, deliberately unmapped: it is the same
 * vocabulary the sidebar's kind badge, the search palette and the status bar
 * use, and a canvas that said "folder" while the badge for the same node said
 * "directory" would raise exactly the question this is meant to settle.
 *
 * Canvas views only. The L5 function view already states its kind in its own
 * header, where it sits beside the symbol name.
 */

import { selectTopEntry, useAppStore } from '../state/store';

export function ViewKind() {
  const top = useAppStore(selectTopEntry);
  if (!top) return null;
  return (
    <div className="view-kind" aria-live="polite">
      {top.kind}
    </div>
  );
}
