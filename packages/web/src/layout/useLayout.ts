/**
 * Main-thread client for the ELK layout worker: one lazily-created worker,
 * promise-per-request correlation, plus a small React hook used by the canvas.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  LayoutDirection,
  LayoutEdgeInput,
  LayoutNodeInput,
  LayoutPoint,
  LayoutPosition,
  LayoutRequest,
  LayoutResponse,
  LayoutRoute,
} from './messages';

/** One worker reply, unpacked. */
export interface LayoutReply {
  positions: LayoutPosition[];
  routes: LayoutRoute[];
}

interface PendingRequest {
  resolve: (reply: LayoutReply) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
    const { id, positions, routes, error } = event.data;
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    if (error !== undefined) req.reject(new Error(error));
    else req.resolve({ positions, routes });
  };
  worker.onerror = (event: ErrorEvent) => {
    // Worker itself broke: fail everything in flight and start fresh next time.
    const err = new Error(event.message || 'elk worker error');
    for (const req of pending.values()) req.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Lay out one view's nodes/edges off the main thread. */
export function requestLayout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  direction: LayoutDirection,
): Promise<LayoutReply> {
  if (nodes.length === 0) return Promise.resolve({ positions: [], routes: [] });
  const id = nextRequestId++;
  const message: LayoutRequest = { id, nodes, edges, direction };
  return new Promise<LayoutReply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(message);
  });
}

export interface LayoutResult {
  /** node id → position; null while (re)computing or before first layout. */
  positions: Map<string, LayoutPosition> | null;
  /**
   * edge id → ELK's routed polyline. Same generation as `positions` — they are
   * only ever replaced together, so an edge is never drawn along a route that
   * belongs to a different arrangement of nodes. An edge missing from the map
   * has no route and falls back to a smoothstep.
   */
  routes: Map<string, LayoutPoint[]> | null;
  layouting: boolean;
  error: string | null;
}

const EMPTY: LayoutResult = { positions: null, routes: null, layouting: false, error: null };

/**
 * React hook: recompute layout whenever the inputs change. `key` identifies
 * the view (layout is skipped when inputs are referentially unchanged).
 */
export function useLayout(
  key: string,
  nodes: LayoutNodeInput[] | null,
  edges: LayoutEdgeInput[] | null,
  direction: LayoutDirection,
): LayoutResult {
  const [result, setResult] = useState<LayoutResult>(EMPTY);
  const generation = useRef(0);
  const lastKey = useRef(key);

  useEffect(() => {
    if (nodes === null || edges === null) {
      lastKey.current = key;
      setResult(EMPTY);
      return;
    }
    const gen = ++generation.current;
    // Re-laying out the SAME view keeps the old arrangement on screen until
    // the new one lands. The throttled refetch while indexing rebuilds these
    // inputs every couple of seconds, and dropping to `null` each time made a
    // steady view announce itself as unlaid-out on a 2s cycle. A different
    // view has no previous arrangement worth showing, so that one still blanks.
    const sameView = lastKey.current === key;
    lastKey.current = key;
    setResult((prev) =>
      sameView
        ? { ...prev, layouting: true, error: null }
        : { positions: null, routes: null, layouting: true, error: null },
    );
    requestLayout(nodes, edges, direction)
      .then((reply) => {
        if (generation.current !== gen) return;
        setResult({
          positions: new Map(reply.positions.map((p) => [p.id, p])),
          routes: new Map(reply.routes.map((r) => [r.id, r.points])),
          layouting: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        setResult({
          positions: null,
          routes: null,
          layouting: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [key, nodes, edges, direction]);

  return result;
}
