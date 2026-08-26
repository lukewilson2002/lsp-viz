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
import type { LayoutDirection } from '../../layout/messages';
import type { CardVariant } from '../cardModel';
import { cardRows } from '../cardModel';
import { kindGlyph } from '../glyphs';
import { NodeHandles } from './NodeHandles';
import { IOPanel, LinksRow, useNodeIO } from './NodeIO';

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
        <div className="node-card-signature" title={rows.signature}>
          {rows.signature}
        </div>
      ) : null}
      {rows.path !== null ? (
        <div className="node-card-path" title={node.path}>
          {rows.path}
        </div>
      ) : null}
      <div className="node-card-facts">{rows.facts}</div>
      {rows.exports !== null ? <div className="node-card-exports">{rows.exports}</div> : null}
      <LinksRow node={node} links={links} expanded={expanded} />
      {expanded ? <IOPanel node={node} detail={detail} /> : null}
    </div>
  );
}
