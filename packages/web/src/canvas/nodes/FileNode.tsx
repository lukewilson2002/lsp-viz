import type { NodeProps } from '@xyflow/react';
import type { FileFlowNode } from '../types';
import { NodeCard } from './NodeCard';

/** File card: name, loc, export summary, expandable in/out links. */
export function FileNode({ data, selected }: NodeProps<FileFlowNode>) {
  const { node, direction, viewIn, viewOut } = data;
  const exportCount = node.attrs?.exportCount ?? 0;
  const exportedNames = node.attrs?.exportedNames ?? [];
  const loc = node.attrs?.loc;
  return (
    <NodeCard
      variant="file"
      node={node}
      direction={direction}
      selected={selected}
      viewIn={viewIn}
      viewOut={viewOut}
      title={node.path}
      entryBadge={node.attrs?.entry ?? false}
      summary={
        <>
          <div className="node-card-sub">
            {exportCount} export{exportCount === 1 ? '' : 's'}
            {loc !== undefined ? ` · ${loc} loc` : ''}
          </div>
          {exportedNames.length > 0 ? (
            <div className="node-card-exports">
              {exportedNames.slice(0, 3).join(', ')}
              {exportCount > 3 ? ', …' : ''}
            </div>
          ) : null}
        </>
      }
    />
  );
}
