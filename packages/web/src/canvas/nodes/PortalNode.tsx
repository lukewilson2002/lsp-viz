import type { NodeProps } from '@xyflow/react';
import { kindGlyph } from '../glyphs';
import type { PortalFlowNode } from '../types';
import { NodeHandles } from './NodeHandles';

/**
 * Ghost node for a symbol OUTSIDE the current file/class view. Double-click
 * jumps to its parent view with the symbol selected and centered.
 */
export function PortalNode({ data, selected }: NodeProps<PortalFlowNode>) {
  const { node } = data;
  return (
    <div
      className={`portal-node${selected ? ' portal-node--selected' : ''}`}
      title={`${node.name} — ${node.path} (double-click to jump)`}
    >
      <NodeHandles direction={data.direction} />
      <div className="portal-head">
        <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
          {kindGlyph(node.kind)}
        </span>
        <span className="portal-name">{node.name}</span>
      </div>
      <div className="portal-path">{node.path}</div>
    </div>
  );
}
