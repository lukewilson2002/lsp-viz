/**
 * Geometry for ELK-routed edges: polyline -> SVG path.
 *
 * Pure, DOM-free and React-free on purpose — this is the only part of the
 * routed-edge work with a right and a wrong answer, so it is kept where it can
 * be exercised directly.
 */

import type { LayoutPoint } from '../../layout/messages';

/** Matches React Flow's `getSmoothStepPath` default, so corners look the same. */
export const CORNER_RADIUS = 5;

function distance(a: LayoutPoint, b: LayoutPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Trim float noise out of the path string; ELK's own values are integers. */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Drop points that carry no shape: exact repeats, and interior points that lie
 * *along* the run they sit in.
 *
 * Both fall out of snapping the endpoints — replacing ELK's start point with
 * the handle position frequently makes it identical to the first bend, and a
 * zero-length segment turns the corner-rounding maths into `0/0`. A 180°
 * reversal is collinear too but is NOT dropped (`dot > 0`), since removing it
 * would silently straighten a real doubling-back.
 */
export function simplifyRoute(points: readonly LayoutPoint[]): LayoutPoint[] {
  const out: LayoutPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    const next = out[i + 1]!;
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const collinear = Math.abs(ax * by - ay * bx) < 1e-6;
    if (collinear && ax * bx + ay * by > 0) out.splice(i, 1);
  }
  return out;
}

/**
 * An SVG path through `points` with rounded corners.
 *
 * Each corner eats at most half of either adjoining segment, so two corners
 * sharing a short segment meet in the middle instead of overshooting each
 * other — which is what keeps a tight 2-bend jog from drawing as a bow-tie.
 * Direction is taken from normalised vectors rather than assumed axis-aligned:
 * endpoint snapping can leave one short diagonal at either end.
 *
 * Returns `''` for anything with fewer than two distinct points — the caller
 * treats that as "no usable route" and falls back to a smoothstep.
 */
export function routeToPath(points: readonly LayoutPoint[], radius = CORNER_RADIUS): string {
  const pts = simplifyRoute(points);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length < 2 || !first || !last) return '';

  let d = `M${n(first.x)},${n(first.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const inLen = distance(prev, cur);
    const outLen = distance(cur, next);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const enterX = cur.x + ((prev.x - cur.x) / inLen) * r;
    const enterY = cur.y + ((prev.y - cur.y) / inLen) * r;
    const exitX = cur.x + ((next.x - cur.x) / outLen) * r;
    const exitY = cur.y + ((next.y - cur.y) / outLen) * r;
    d += `L${n(enterX)},${n(enterY)}Q${n(cur.x)},${n(cur.y)} ${n(exitX)},${n(exitY)}`;
  }
  return `${d}L${n(last.x)},${n(last.y)}`;
}

/**
 * Re-anchor a route on the handles React Flow actually rendered.
 *
 * ELK is free to spread several attachments along a node's border, while
 * `NodeHandles` draws one centred handle per side. `elk.layered.mergeEdges`
 * makes the two agree in the ordinary case (merged edges leave from the border
 * centre), but nothing guarantees it, and an unsnapped route detaches from its
 * own arrowhead. ELK's interior bends — the part that does the obstacle
 * avoidance — are kept untouched.
 */
export function snapRouteEnds(
  points: readonly LayoutPoint[],
  source: LayoutPoint,
  target: LayoutPoint,
): LayoutPoint[] {
  if (points.length < 2) return [source, target];
  return [source, ...points.slice(1, -1), target];
}

/** Midpoint of the polyline by arc length — where a routed edge's label sits. */
export function routeMidpoint(points: readonly LayoutPoint[]): LayoutPoint | null {
  const pts = simplifyRoute(points);
  if (pts.length < 2) return null;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1]!, pts[i]!);
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = distance(a, b);
    if (travelled + len >= total / 2) {
      const t = len === 0 ? 0 : (total / 2 - travelled) / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += len;
  }
  return pts[pts.length - 1]!;
}
