import type { NodeProps } from '@xyflow/react';
import type { ContainerFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** Workspace / package / directory card. */
export function ContainerNode({ data, selected }: NodeProps<ContainerFlowNode>) {
  const { node, direction, links } = data;
  return (
    <NodeCard
      variant="container"
      node={node}
      direction={direction}
      selected={selected}
      links={links}
    />
  );
}
