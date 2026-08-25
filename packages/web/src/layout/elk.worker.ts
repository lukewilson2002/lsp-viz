/**
 * ELK layout in a dedicated Web Worker — elkjs's bundled (synchronous) build
 * runs here so layout never blocks the main thread.
 */

import './elkEnv'; // must precede the elk import — see elkEnv.ts
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { LayoutRequest, LayoutResponse } from './messages';

declare const self: DedicatedWorkerGlobalScope;

const elk = new ELK();

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  void runLayout(event.data);
};

async function runLayout(request: LayoutRequest): Promise<void> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': request.direction,
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.edgeNode': '24',
      'elk.layered.mergeEdges': 'true',
    },
    children: request.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: request.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  let response: LayoutResponse;
  try {
    const laidOut = await elk.layout(graph);
    response = {
      id: request.id,
      positions: (laidOut.children ?? []).map((child) => ({
        id: child.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
      })),
    };
  } catch (err) {
    response = {
      id: request.id,
      positions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(response);
}
