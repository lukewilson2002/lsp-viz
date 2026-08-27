import type { NodeProps } from '@xyflow/react';
import type { ClusterFlowNode, PortalClusterFlowNode } from '../types';
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

/**
 * The ghosts, collapsed: every external symbol this view links to, behind one
 * count.
 *
 * Dashed-and-stacked like the ghosts it stands for rather than like the LOD
 * cluster, because it answers a different question. "+N more" hides the view's
 * OWN children; this hides its surroundings — and the count is of SYMBOLS, not
 * of ghosts, so a roll-up ghost standing for six contributes six.
 */
export function PortalClusterNode({ data, selected }: NodeProps<PortalClusterFlowNode>) {
  return (
    <div
      className={`cluster-node cluster-node--portal${selected ? ' cluster-node--selected' : ''}`}
      title={`${data.count} symbols outside this view link to it — double-click to show them`}
    >
      <NodeHandles direction={data.direction} />
      <span className="cluster-count">{data.count} external symbols</span>
      <span className="cluster-hint">double-click to expand</span>
    </div>
  );
}
