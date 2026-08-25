import type { NodeProps } from '@xyflow/react';
import type { SymbolFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** Declaration card (function/class/method/interface/type/variable). */
export function SymbolNode({ data, selected }: NodeProps<SymbolFlowNode>) {
  const { node, direction, viewIn, viewOut } = data;
  return (
    <NodeCard
      variant="symbol"
      node={node}
      direction={direction}
      selected={selected}
      viewIn={viewIn}
      viewOut={viewOut}
      title={node.signature ?? node.name}
      glyphClassName={`kind-glyph kind-glyph--${node.kind}`}
      summary={
        node.signature !== undefined && node.signature !== '' ? (
          <div className="node-card-signature">{node.signature}</div>
        ) : null
      }
    />
  );
}
