/**
 * Main-thread client for the ELK layout worker: one lazily-created worker,
 * promise-per-request correlation, plus a small React hook used by the canvas.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  LayoutDirection,
  LayoutEdgeInput,
  LayoutNodeInput,
  LayoutPosition,
  LayoutRequest,
  LayoutResponse,
} from './messages';

interface PendingRequest {
  resolve: (positions: LayoutPosition[]) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
    const { id, positions, error } = event.data;
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    if (error !== undefined) req.reject(new Error(error));
    else req.resolve(positions);
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
): Promise<LayoutPosition[]> {
  if (nodes.length === 0) return Promise.resolve([]);
  const id = nextRequestId++;
  const message: LayoutRequest = { id, nodes, edges, direction };
  return new Promise<LayoutPosition[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(message);
  });
}

export interface LayoutResult {
  /** node id → position; null while (re)computing or before first layout. */
  positions: Map<string, LayoutPosition> | null;
  layouting: boolean;
  error: string | null;
}

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
  const [result, setResult] = useState<LayoutResult>({
    positions: null,
    layouting: false,
    error: null,
  });
  const generation = useRef(0);

  useEffect(() => {
    if (nodes === null || edges === null) {
      setResult({ positions: null, layouting: false, error: null });
      return;
    }
    const gen = ++generation.current;
    setResult({ positions: null, layouting: true, error: null });
    requestLayout(nodes, edges, direction)
      .then((positions) => {
        if (generation.current !== gen) return;
        setResult({
          positions: new Map(positions.map((p) => [p.id, p])),
          layouting: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        setResult({
          positions: null,
          layouting: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [key, nodes, edges, direction]);

  return result;
}
