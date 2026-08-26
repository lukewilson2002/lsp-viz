import type { NodeProps } from '@xyflow/react';
import type { SymbolFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** Declaration card (function/class/method/interface/type/variable). */
export function SymbolNode({ data, selected }: NodeProps<SymbolFlowNode>) {
  const { node, direction, links } = data;
  return (
    <NodeCard
      variant="symbol"
      node={node}
      direction={direction}
      selected={selected}
      links={links}
    />
  );
}
