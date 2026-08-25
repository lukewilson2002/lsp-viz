import type { NodeProps } from '@xyflow/react';
import type { ContainerFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** Workspace / package / directory card. */
export function ContainerNode({ data, selected }: NodeProps<ContainerFlowNode>) {
  const { node, direction, viewIn, viewOut } = data;
  const symbolCount = node.attrs?.symbolCount;
  return (
    <NodeCard
      variant="container"
      node={node}
      direction={direction}
      selected={selected}
      viewIn={viewIn}
      viewOut={viewOut}
      title={node.path || node.name}
      entryBadge={node.attrs?.entry ?? false}
      summary={
        <div className="node-card-sub">
          {node.kind}
          {symbolCount !== undefined ? ` · ${symbolCount} symbols` : ''}
        </div>
      }
    />
  );
}
