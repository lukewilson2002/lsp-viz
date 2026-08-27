/** Message shapes exchanged with the ELK layout worker. */

export type LayoutDirection = 'DOWN' | 'RIGHT';

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface LayoutRequest {
  /** Correlation id — echoed back in the response. */
  id: number;
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  direction: LayoutDirection;
}

export interface LayoutPosition {
  id: string;
  x: number;
  y: number;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * ELK's obstacle-avoiding polyline for one edge, in layout coordinates — the
 * same space as `LayoutPosition`, so a route point and a node corner are
 * directly comparable.
 *
 * ELK routes edges around the cards that sit between their endpoints; drawing
 * the endpoints ourselves and guessing the middle (which is all a smoothstep
 * can do) is what put arrows through the middle of unrelated nodes.
 */
export interface LayoutRoute {
  /** Matches `LayoutEdgeInput.id`. */
  id: string;
  /** startPoint, ...bendPoints, endPoint. */
  points: LayoutPoint[];
}

export interface LayoutResponse {
  id: number;
  positions: LayoutPosition[];
  /** One entry per edge ELK routed — an edge with no usable route is omitted. */
  routes: LayoutRoute[];
  /** Set when ELK failed; positions is empty then. */
  error?: string;
}
