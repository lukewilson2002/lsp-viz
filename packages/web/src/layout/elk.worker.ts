/**
 * ELK layout in a dedicated Web Worker — elkjs's bundled (synchronous) build
 * runs here so layout never blocks the main thread.
 */

import './elkEnv'; // must precede the elk import — see elkEnv.ts
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { LayoutPoint, LayoutRequest, LayoutResponse, LayoutRoute } from './messages';

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
      // Stated explicitly because it is now load-bearing: the renderer draws
      // these routes verbatim, so the edge-node spacing above is buying real
      // channels rather than clearance nothing used.
      'elk.edgeRouting': 'ORTHOGONAL',
      // Merging keeps shared trunks tidy AND lands every endpoint on its
      // node's border centre — exactly where React Flow's single per-side
      // handle sits, so routes meet their arrow markers without correction.
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
      routes: collectRoutes(laidOut),
    };
  } catch (err) {
    response = {
      id: request.id,
      positions: [],
      routes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(response);
}

/**
 * Flatten each laid-out edge's `sections` into one point list.
 *
 * A 1:1 edge always comes back as a single section, but the field is typed for
 * hyperedges, so sections are concatenated in order and the seam between two
 * of them (one's endPoint == the next's startPoint) is dropped. An edge whose
 * sections are missing or degenerate is OMITTED rather than half-described:
 * the renderer falls back to a smoothstep for anything it has no route for.
 */
function collectRoutes(laidOut: ElkNode): LayoutRoute[] {
  const routes: LayoutRoute[] = [];
  for (const edge of laidOut.edges ?? []) {
    const sections = edge.sections;
    if (!sections || sections.length === 0) continue;
    const points: LayoutPoint[] = [];
    for (const section of sections) {
      for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        const last = points[points.length - 1];
        if (last && last.x === point.x && last.y === point.y) continue;
        points.push({ x: point.x, y: point.y });
      }
    }
    if (points.length < 2) continue;
    routes.push({ id: edge.id, points });
  }
  return routes;
}
