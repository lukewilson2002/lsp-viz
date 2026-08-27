/**
 * Shared scaffolding for the three graph-backed card types (container, file,
 * symbol). Every row a card can show is decided by `cardRows` — the same
 * function `canvas/types.ts` measures — so nothing renders that ELK did not
 * reserve height for, and the per-kind components carry no layout knowledge.
 *
 * All rows are unconditional: identifying a node (name, path, kind, metrics,
 * link counts) must never require a click or a hover. The only thing behind
 * an interaction is the enumerated link list, which is unbounded and so
 * cannot live in a fixed-height card.
 */

import type { GraphNode, LinkCounts } from '@lsp-viz/core';
import { CodeSignature } from '../../code/CodeSignature';
import type { LayoutDirection } from '../../layout/messages';
import { useAppStore } from '../../state/store';
import type { CardVariant } from '../cardModel';
import { cardRows } from '../cardModel';
import { kindGlyph } from '../glyphs';
import { NodeHandles } from './NodeHandles';
import { IOPanel, LinksRow, useNodeIO } from './NodeIO';

/**
 * The card's signature block: highlighted, and clickable through to the types
 * it names.
 *
 * Its link set is fetched ON FIRST HOVER rather than with the view. A view
 * holds dozens of cards and every one of them would otherwise cost a
 * `/api/links` call on arrival, to answer a question nobody asked — while
 * hovering a card is exactly the move that precedes clicking inside it, and
 * the store caches and de-dupes the answer from then on.
 */
function CardSignature({ node, signature }: { node: GraphNode; signature: string }) {
  const links = useAppStore((s) => s.sourceLinks[node.id]?.links ?? null);
  const ensureSourceLinks = useAppStore((s) => s.ensureSourceLinks);
  return (
    <CodeSignature
      className="node-card-signature nodrag"
      signature={signature}
      language={node.language}
      path={node.path}
      links={links ?? undefined}
      onMouseEnter={() => {
        if (links === null) void ensureSourceLinks(node.id);
      }}
    />
  );
}

export function NodeCard({
  variant,
  node,
  direction,
  selected,
  links,
}: {
  variant: CardVariant;
  node: GraphNode;
  direction: LayoutDirection;
  selected: boolean;
  links: LinkCounts;
}) {
  const { expanded, detail } = useNodeIO(node.id);
  const rows = cardRows(node);
  const classes = [
    'node-card',
    `node-card--${variant}`,
    selected ? 'node-card--selected' : '',
    expanded ? 'node-card--expanded' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      <NodeHandles direction={direction} />
      <div className="node-card-head">
        <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
          {kindGlyph(node.kind)}
        </span>
        <span className="node-card-name" title={node.name}>
          {rows.name}
        </span>
        {rows.entry ? <span className="entry-badge">entry</span> : null}
      </div>
      {rows.signature !== null ? (
        <CardSignature node={node} signature={rows.signature} />
      ) : null}
      {rows.path !== null ? (
        <div className="node-card-path" title={node.path}>
          {rows.path}
        </div>
      ) : null}
      {rows.facts !== null ? <div className="node-card-facts">{rows.facts}</div> : null}
      {rows.exports !== null ? <div className="node-card-exports">{rows.exports}</div> : null}
      <LinksRow node={node} links={links} expanded={expanded} />
      {expanded ? <IOPanel node={node} detail={detail} /> : null}
    </div>
  );
}
