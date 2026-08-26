import type { NodeProps } from '@xyflow/react';
import type { FileFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** File card: name, directory, loc/export metrics, exported names, links. */
export function FileNode({ data, selected }: NodeProps<FileFlowNode>) {
  const { node, direction, links } = data;
  return (
    <NodeCard
      variant="file"
      node={node}
      direction={direction}
      selected={selected}
      links={links}
    />
  );
}
