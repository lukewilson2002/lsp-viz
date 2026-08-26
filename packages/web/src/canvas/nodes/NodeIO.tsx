/**
 * The card's links row and the panel it expands. The row states the
 * high-level answer — how many links the node has — and expanding it
 * enumerates those same links from /api/node/:id. Both numbers describe ONE
 * set: the row's counts ride along on /api/graph (`linkCounts`) and the server
 * derives them from the same function that builds the lists, so the headline
 * can never promise links the expansion doesn't show. Expansion state +
 * fetched details live in the store (global, so it survives Back/forward); the
 * canvas grows node dimensions to match so ELK lays out around the open card.
 *
 * The uncapped, unclamped version of these lists lives in the sidebar — the
 * card deliberately stops at IO_MAX_ROWS with an inner scroll.
 */

import type { CallLink, GraphNode, LinkCounts, NodeDetailResponse } from '@lsp-viz/core';
import { useEffect } from 'react';
import type { MouseEvent } from 'react';
import { useAppStore } from '../../state/store';
import { kindGlyph } from '../glyphs';
import { IO_MAX_ROWS, IO_ROW_HEIGHT } from '../types';

/** Expansion + cached detail for one node; refetches detail when missing. */
export function useNodeIO(id: string): {
  expanded: boolean;
  detail: NodeDetailResponse | null;
} {
  const expanded = useAppStore((s) => s.expandedIO[id] === true);
  const detail = useAppStore((s) => s.nodeDetails[id] ?? null);
  const ensureNodeDetail = useAppStore((s) => s.ensureNodeDetail);
  useEffect(() => {
    // Covers cache invalidation (index:done) and views restored via Back.
    if (expanded && detail === null) void ensureNodeDetail(id);
  }, [expanded, detail, id, ensureNodeDetail]);
  return { expanded, detail };
}

const stop = (event: MouseEvent): void => {
  event.stopPropagation();
};

/**
 * Last row of every card: the node's in/out link totals, and the toggle for
 * the lists behind them. The totals are the LENGTHS of those lists (see the
 * module header), so "3 in" always expands to three rows. A node with no links
 * renders quiet but stays clickable — the panel then says so outright, which
 * is the answer to "does this really connect to nothing?".
 */
export function LinksRow({
  node,
  links,
  expanded,
}: {
  node: GraphNode;
  links: LinkCounts;
  expanded: boolean;
}) {
  const toggle = useAppStore((s) => s.toggleIOExpanded);
  const { inCount, outCount } = links;
  const quiet = inCount + outCount === 0;
  return (
    <button
      className={`node-links nodrag${expanded ? ' node-links--open' : ''}${
        quiet ? ' node-links--quiet' : ''
      }`}
      aria-expanded={expanded}
      aria-label={
        `${node.name}: ${inCount} incoming, ${outCount} outgoing links — ` +
        `${expanded ? 'collapse' : 'expand'} the link list`
      }
      title={`${inCount} incoming · ${outCount} outgoing — click to list them`}
      onClick={(event) => {
        event.stopPropagation();
        toggle(node.id);
      }}
      onDoubleClick={stop}
      onMouseDown={stop}
      onKeyDown={(event) => {
        // GraphCanvas listens for Enter on window to drill into the selection;
        // React 18 bubbles this to window after the root handler, so without
        // the stop, activating the row would also drill.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      <span className="node-links-label">
        {inCount} in · {outCount} out
      </span>
      <span className="node-links-chevron" aria-hidden>
        ›
      </span>
    </button>
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function IOSection({ label, links }: { label: string; links: readonly CallLink[] }) {
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  if (links.length === 0) return null;
  return (
    <div className="node-io-section">
      <div className="node-io-label">{`${label} · ${links.length}`}</div>
      <div
        className={`node-io-rows${links.length > IO_MAX_ROWS ? ' nowheel' : ''}`}
        style={{ maxHeight: IO_MAX_ROWS * IO_ROW_HEIGHT }}
      >
        {links.map((link) => (
          <button
            key={link.edge.id}
            className="node-io-row nodrag"
            onClick={(event) => {
              event.stopPropagation();
              void navigateToNode(link.node.id);
            }}
            onDoubleClick={stop}
            onMouseDown={stop}
            title={`${link.node.name} — ${link.node.path}`}
          >
            <span className={`kind-glyph kind-glyph--${link.node.kind}`} aria-hidden>
              {kindGlyph(link.node.kind)}
            </span>
            <span className="node-io-name">{link.node.name}</span>
            <span className="node-io-file">{basename(link.node.path)}</span>
            {link.edge.count > 1 ? <span className="node-io-count">×{link.edge.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The expanded card body: purely the enumerated links. The node's own fields
 * (path, signature, metrics) are always-on rows above the row that toggles
 * this panel, so the panel is additive — it never replaces anything.
 */
export function IOPanel({
  node,
  detail,
}: {
  node: GraphNode;
  detail: NodeDetailResponse | null;
}) {
  const hasLinks = detail !== null && (detail.incoming.length > 0 || detail.outgoing.length > 0);
  return (
    <div className="node-io" role="group" aria-label={`links for ${node.name}`}>
      {detail === null ? <div className="node-io-note">loading links…</div> : null}
      {detail !== null && !hasLinks ? (
        // Only ever reached under a "0 in · 0 out" row — the counts and these
        // lists are the same server-side set.
        <div className="node-io-note">{`no links for this ${node.kind}`}</div>
      ) : null}
      {detail !== null ? (
        <>
          <IOSection label="incoming" links={detail.incoming} />
          <IOSection label="outgoing" links={detail.outgoing} />
        </>
      ) : null}
    </div>
  );
}
