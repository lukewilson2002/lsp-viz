/**
 * Geometry for ELK-routed edges.
 *
 * The fixture below is not invented: it is the real route elkjs 0.12 returns
 * for a long edge spanning four stacked cards (a->b->c->d plus a->d), the case
 * that made edges cut through unrelated nodes. Cards occupy x 37..337; ELK
 * sends the long edge down a dedicated channel at x=12, clear of all of them.
 * These tests pin the polyline -> SVG conversion that finally draws it.
 */

import { describe, expect, it } from 'vitest';
import type { LayoutPoint } from '../src/layout/messages';
import {
  routeMidpoint,
  routeToPath,
  simplifyRoute,
  snapRouteEnds,
} from '../src/canvas/edges/routePath';

/** Terse point-list literal: p([0, 0], [0, 10]). */
function p(...pairs: [number, number][]): LayoutPoint[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

/** ELK's a->d route: down, left into the channel at x=12, along, and back in. */
const A_TO_D = p([187, 108], [187, 118], [12, 118], [12, 470], [187, 470], [187, 540]);

describe('simplifyRoute', () => {
  it('drops exact repeats', () => {
    expect(simplifyRoute(p([0, 0], [0, 0], [0, 10]))).toEqual(p([0, 0], [0, 10]));
  });

  it('drops an interior point that lies along its own run', () => {
    expect(simplifyRoute(p([0, 0], [0, 5], [0, 10]))).toEqual(p([0, 0], [0, 10]));
  });

  it('keeps a real corner', () => {
    const corner = p([0, 0], [0, 10], [10, 10]);
    expect(simplifyRoute(corner)).toEqual(corner);
  });

  // Collinear but reversed: dropping it would silently straighten a real
  // doubling-back, so the direction check (dot > 0) has to reject this one.
  it('keeps a 180-degree reversal', () => {
    const reversal = p([0, 0], [0, 10], [0, 0]);
    expect(simplifyRoute(reversal)).toEqual(reversal);
  });
});

describe('routeToPath', () => {
  it('draws a straight run with no curves', () => {
    expect(routeToPath(p([187, 108], [187, 188]))).toBe('M187,108L187,188');
  });

  it('returns nothing for a route with fewer than two distinct points', () => {
    expect(routeToPath(p([5, 5], [5, 5]))).toBe('');
    expect(routeToPath(p([5, 5]))).toBe('');
    expect(routeToPath([])).toBe('');
  });

  it('rounds every bend of a real ELK route', () => {
    const d = routeToPath(A_TO_D);
    expect(d.match(/Q/g)).toHaveLength(4);
    expect(d.startsWith('M187,108')).toBe(true);
    expect(d.endsWith('L187,540')).toBe(true);
  });

  it('keeps the route in ELK’s channel, clear of the cards it passes', () => {
    // Cards span x 37..337; the long run must stay at x=12, left of all of them.
    expect(routeToPath(A_TO_D)).toContain('L12,465');
  });

  // Two 5px corners sharing a 6px segment would each want to eat 5px of it and
  // overshoot each other, drawing a bow-tie: the second corner's entry (x=1)
  // would sit BEHIND the first corner's exit (x=5). Capping each corner at half
  // of either neighbour makes them meet at x=3 instead.
  it('clamps the corner radius to half of the shortest adjoining segment', () => {
    expect(routeToPath(p([0, 0], [0, 6], [6, 6], [6, 12]))).toBe(
      'M0,0L0,3Q0,6 3,6L3,6Q6,6 6,9L6,12',
    );
  });

  it('leaves corners at full radius when the segments are long enough', () => {
    expect(routeToPath(A_TO_D)).toContain('L187,113Q187,118');
  });

  it('survives a non-orthogonal segment left by endpoint snapping', () => {
    const jog = routeToPath(snapRouteEnds(p([100, 0], [100, 50], [200, 50], [200, 100]), { x: 90, y: 0 }, { x: 200, y: 100 }));
    expect(jog).not.toMatch(/NaN|Infinity/);
    expect(jog.startsWith('M90,0')).toBe(true);
  });
});

describe('snapRouteEnds', () => {
  it('replaces both endpoints and keeps every interior bend', () => {
    expect(snapRouteEnds(A_TO_D, { x: 190, y: 110 }, { x: 190, y: 538 })).toEqual(
      p([190, 110], [187, 118], [12, 118], [12, 470], [187, 470], [190, 538]),
    );
  });

  it('replaces both points of a bend-free route', () => {
    expect(snapRouteEnds(p([0, 0], [0, 9]), { x: 1, y: 1 }, { x: 2, y: 8 })).toEqual(
      p([1, 1], [2, 8]),
    );
  });

  it('yields a drawable pair even from a degenerate route', () => {
    expect(snapRouteEnds(p([0, 0]), { x: 1, y: 1 }, { x: 2, y: 8 })).toEqual(p([1, 1], [2, 8]));
  });
});

describe('routeMidpoint', () => {
  it('measures by arc length, not by endpoint average', () => {
    // Total length 10 + 175 + 352 + 175 + 70 = 782; the halfway mark at 391
    // falls partway down the long channel run, nowhere near the endpoints.
    expect(routeMidpoint(A_TO_D)).toEqual({ x: 12, y: 324 });
  });

  it('halves a straight run', () => {
    expect(routeMidpoint(p([0, 0], [0, 100]))).toEqual({ x: 0, y: 50 });
  });

  it('has no midpoint without a route', () => {
    expect(routeMidpoint(p([5, 5]))).toBeNull();
    expect(routeMidpoint([])).toBeNull();
  });
});
