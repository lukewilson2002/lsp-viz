import type { NodeProps } from '@xyflow/react';
import type { ClusterFlowNode } from '../types';
import { NodeHandles } from './NodeHandles';

/** LOD cluster: the N smallest children collapsed into one expandable node. */
export function ClusterNode({ data, selected }: NodeProps<ClusterFlowNode>) {
  return (
    <div
      className={`cluster-node${selected ? ' cluster-node--selected' : ''}`}
      title="Double-click to show all children"
    >
      <NodeHandles direction={data.direction} />
      <span className="cluster-count">+{data.count} more</span>
      <span className="cluster-hint">double-click to expand</span>
    </div>
  );
}
