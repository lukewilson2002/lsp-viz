import type { NodeProps } from '@xyflow/react';
import { formatCardPath } from '../cardModel';
import { kindGlyph } from '../glyphs';
import type { PortalFlowNode } from '../types';
import { NodeHandles } from './NodeHandles';

/**
 * Ghost node for something OUTSIDE the current file/class view. Double-click
 * jumps to it.
 *
 * Two forms, one shape. Normally it is ONE external symbol and double-click
 * lands on it, selected and centred, in its parent's view. When a single
 * neighbouring declaration supplied several of this view's external symbols
 * they roll up (see `rollUpPortals`) and the ghost becomes that declaration,
 * with the symbol count on the location row and their names in the tooltip —
 * summarised, never hidden.
 *
 * Deliberately stays a two-row ghost while real cards grew a full row stack:
 * a portal is a POINTER to a declaration elsewhere, and giving it the same
 * weight as the file's own declarations would make it compete with them.
 */
export function PortalNode({ data, selected }: NodeProps<PortalFlowNode>) {
  const { node, groupCount, groupNames } = data;
  const signature = node.signature !== undefined && node.signature !== '' ? node.signature : null;
  const title =
    groupCount !== undefined
      ? `${node.path}\n${groupCount} symbols used here: ${(groupNames ?? []).join(', ')}\n(double-click to open)`
      : `${node.name}${signature !== null ? ` — ${signature}` : ''}\n${node.path}\n(double-click to jump)`;
  return (
    <div
      className={`portal-node${selected ? ' portal-node--selected' : ''}${groupCount !== undefined ? ' portal-node--group' : ''}`}
      title={title}
    >
      <NodeHandles direction={data.direction} />
      <div className="portal-head">
        <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
          {kindGlyph(node.kind)}
        </span>
        <span className="portal-name">{node.name}</span>
      </div>
      <div className="portal-path">
        {groupCount !== undefined ? `${groupCount} symbols` : (formatCardPath(node) ?? node.path)}
      </div>
    </div>
  );
}
