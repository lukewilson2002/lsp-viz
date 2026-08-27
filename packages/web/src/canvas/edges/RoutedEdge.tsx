import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { RoutedFlowEdge } from '../types';
import { routeMidpoint, routeToPath, snapRouteEnds } from './routePath';

/**
 * Draws the polyline ELK already computed for this edge, instead of the
 * two-node-blind L that a smoothstep can draw.
 *
 * ELK routes edges through the channels it reserves between layers (that is
 * what `elk.spacing.edgeNode` pays for), so a link spanning three layers goes
 * *around* the cards in between rather than straight down through them. All of
 * that geometry used to be computed and thrown away.
 *
 * With no usable route — ELK failed, or an edge came back without sections —
 * this falls back to exactly the smoothstep that was drawn before, so the
 * change can never leave an edge undrawn.
 */
export function RoutedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps<RoutedFlowEdge>) {
  const route = data?.points;
  let path: string | null = null;
  let labelX = 0;
  let labelY = 0;

  if (route && route.length >= 2) {
    const snapped = snapRouteEnds(
      route,
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
    );
    const d = routeToPath(snapped);
    if (d) {
      path = d;
      const mid = routeMidpoint(snapped);
      labelX = mid?.x ?? (sourceX + targetX) / 2;
      labelY = mid?.y ?? (sourceY + targetY) / 2;
    }
  }

  if (path === null) {
    const [fallback, fallbackX, fallbackY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
    path = fallback;
    labelX = fallbackX;
    labelY = fallbackY;
  }

  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}
