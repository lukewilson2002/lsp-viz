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

export interface LayoutResponse {
  id: number;
  positions: LayoutPosition[];
  /** Set when ELK failed; positions is empty then. */
  error?: string;
}
