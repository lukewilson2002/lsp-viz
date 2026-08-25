/**
 * Shared scaffolding for the three graph-backed card types (container, file,
 * symbol): handles, head (glyph + name + optional entry badge + IOBadge),
 * a collapsed-only summary, and the expanded in/out panel. Each node type
 * supplies only what actually varies — its title, summary content, and glyph
 * class (container/file glyphs are untinted today; only symbol glyphs carry
 * the kind-color modifier — preserved here rather than unified, since that's
 * a visual change, not a structural one).
 */

import type { GraphNode } from '@lsp-viz/core';
import type { ReactNode } from 'react';
import type { LayoutDirection } from '../../layout/messages';
import { kindGlyph } from '../glyphs';
import { NodeHandles } from './NodeHandles';
import { IOBadge, IOPanel, useNodeIO } from './NodeIO';

export function NodeCard({
  variant,
  node,
  direction,
  selected,
  viewIn,
  viewOut,
  title,
  glyphClassName = 'kind-glyph',
  entryBadge = false,
  summary,
}: {
  variant: 'container' | 'file' | 'symbol';
  node: GraphNode;
  direction: LayoutDirection;
  selected: boolean;
  viewIn: number;
  viewOut: number;
  title: string;
  glyphClassName?: string;
  entryBadge?: boolean;
  summary: ReactNode;
}) {
  const { expanded, detail } = useNodeIO(node.id);
  const classes = [
    'node-card',
    `node-card--${variant}`,
    selected ? 'node-card--selected' : '',
    expanded ? 'node-card--expanded' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} title={title}>
      <NodeHandles direction={direction} />
      <div className="node-card-head">
        <span className={glyphClassName} aria-hidden>
          {kindGlyph(node.kind)}
        </span>
        <span className="node-card-name">{node.name}</span>
        {entryBadge ? <span className="entry-badge">entry</span> : null}
        <IOBadge id={node.id} viewIn={viewIn} viewOut={viewOut} expanded={expanded} />
      </div>
      {!expanded ? summary : null}
      {expanded ? <IOPanel node={node} detail={detail} /> : null}
    </div>
  );
}
