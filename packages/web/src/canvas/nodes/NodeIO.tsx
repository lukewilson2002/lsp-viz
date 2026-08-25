/**
 * In-graph node metadata: the badge on a card and the panel it expands —
 * the node's extended fields (path, full signature, metrics) followed by its
 * enumerated INCOMING/OUTGOING links. Expansion state + fetched /api/node
 * details live in the store (global, so it survives Back/forward); the canvas
 * grows node dimensions to match so ELK lays out around the open card.
 */

import type { CallLink, GraphNode, NodeDetailResponse } from '@lsp-viz/core';
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
 * The card's expand toggle: in/out counts for a connected node, a plain
 * "details" affordance for an isolated one. Toggles expansion only — never
 * selects or drills (events stopped).
 */
export function IOBadge({
  id,
  viewIn,
  viewOut,
  expanded,
}: {
  id: string;
  viewIn: number;
  viewOut: number;
  expanded: boolean;
}) {
  const toggle = useAppStore((s) => s.toggleIOExpanded);
  const connected = viewIn > 0 || viewOut > 0;
  return (
    <button
      className={`io-badge nodrag${expanded ? ' io-badge--open' : ''}${
        connected ? '' : ' io-badge--quiet'
      }`}
      onClick={(event) => {
        event.stopPropagation();
        toggle(id);
      }}
      onDoubleClick={stop}
      onMouseDown={stop}
      title={expanded ? 'Collapse details' : 'Expand details and links'}
    >
      {connected ? `${viewIn} in · ${viewOut} out` : 'details'}
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
      <div className="node-io-label">{label}</div>
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

/** The node's extended fields — what used to live in the hover popover. */
function NodeFacts({ node }: { node: GraphNode }) {
  const attrs = node.attrs;
  const facts: string[] = [];
  if (attrs?.loc !== undefined) facts.push(`${attrs.loc} loc`);
  if (attrs?.symbolCount !== undefined) facts.push(`${attrs.symbolCount} symbols`);
  if (attrs?.exportCount !== undefined) {
    facts.push(`${attrs.exportCount} export${attrs.exportCount === 1 ? '' : 's'}`);
  }
  if (attrs?.entry === true) facts.push('entry point');
  const signature = node.signature;
  return (
    <div className="node-facts">
      {node.path !== '' ? <div className="node-facts-path">{node.path}</div> : null}
      {signature !== undefined && signature !== '' ? (
        <div className="node-facts-sig">{signature}</div>
      ) : null}
      {facts.length > 0 ? <div className="node-facts-meta">{facts.join(' · ')}</div> : null}
    </div>
  );
}

/**
 * The expanded card body: extended fields, then the enumerated links.
 * `node` comes from the view graph so the fields render immediately, before
 * the detail fetch that fills in the link lists resolves.
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
    <div className="node-io">
      <NodeFacts node={node} />
      {detail === null ? <div className="node-io-note">loading links…</div> : null}
      {detail !== null && !hasLinks ? (
        // Reached for class/interface cards: the view edges are roll-ups of
        // the members' calls, which belong to the members, not the container.
        <div className="node-io-note">no direct links</div>
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
