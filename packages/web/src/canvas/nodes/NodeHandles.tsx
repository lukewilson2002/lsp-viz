import { Handle, Position } from '@xyflow/react';
import type { LayoutDirection } from '../../layout/messages';

/**
 * Invisible connection handles. Edges are computed by the indexer, never
 * user-drawn, so handles exist purely to anchor edge endpoints in the
 * current layout direction.
 */
export function NodeHandles({ direction }: { direction: LayoutDirection }) {
  const target = direction === 'DOWN' ? Position.Top : Position.Left;
  const source = direction === 'DOWN' ? Position.Bottom : Position.Right;
  return (
    <>
      <Handle className="node-handle" type="target" position={target} isConnectable={false} />
      <Handle className="node-handle" type="source" position={source} isConnectable={false} />
    </>
  );
}
