/**
 * The clickable identifiers for one node's source slice, fetched once and
 * cached in the store.
 *
 * Both source surfaces (the sidebar's Details tab and the L5 view) used to
 * build this prop themselves out of `detail.outgoing`, identically and
 * separately — which drifted in one direction the whole time: a FILE node's
 * outgoing links are `imports` between FILE nodes, so the only names on offer
 * were basenames like `index.ts` and no file source view ever had a single
 * link. One hook over one server-resolved answer removes both the duplication
 * and that whole class of mistake.
 */

import { useEffect } from 'react';
import type { SourceLink } from '@lsp-viz/core';
import { useAppStore } from '../state/store';

/** Stable identity so SourceView's memoized post-processing is not re-run. */
const NO_LINKS: readonly SourceLink[] = [];

export function useCodeLinks(nodeId: string | null): readonly SourceLink[] {
  const ensureSourceLinks = useAppStore((s) => s.ensureSourceLinks);
  const links = useAppStore((s) => (nodeId === null ? null : (s.sourceLinks[nodeId] ?? null)));
  // dataEpoch, not just nodeId: invalidate() empties the cache this reads, and
  // an effect keyed on the id alone would never re-fetch it.
  const dataEpoch = useAppStore((s) => s.dataEpoch);

  useEffect(() => {
    if (nodeId === null) return;
    void ensureSourceLinks(nodeId);
  }, [nodeId, dataEpoch, ensureSourceLinks]);

  return links?.links ?? NO_LINKS;
}
