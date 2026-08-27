import type {
  EdgeKind,
  GraphNode,
  GraphViewResponse,
  LinkCounts,
  NodeDetailResponse,
} from '@lsp-viz/core';
import {
  Background,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useStore as useFlowStore,
} from '@xyflow/react';
import type { EdgeTypes, NodeChange, NodeTypes } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEditableTarget } from '../keys';
import type {
  LayoutDirection,
  LayoutEdgeInput,
  LayoutNodeInput,
  LayoutPoint,
} from '../layout/messages';
import { useLayout } from '../layout/useLayout';
import { selectCurrentGraph, selectTopEntry, useAppStore } from '../state/store';
import type { ViewEntry } from '../state/store';
import { cardVariantForKind } from './cardModel';
import { RoutedEdge } from './edges/RoutedEdge';
import { ClusterNode, PortalClusterNode } from './nodes/ClusterNode';
import { ContainerNode } from './nodes/ContainerNode';
import { FileNode } from './nodes/FileNode';
import { PortalNode } from './nodes/PortalNode';
import { SymbolNode } from './nodes/SymbolNode';
import {
  CLUSTER_NODE_ID,
  LOD_MAX_VISIBLE,
  PORTAL_CLUSTER_NODE_ID,
  PORTAL_MAX_VISIBLE,
  clusterDimensions,
  nodeDimensions,
  portalClusterDimensions,
  portalDimensions,
} from './types';
import type { AppEdge, AppNode, IOExpansion } from './types';

const nodeTypes: NodeTypes = {
  container: ContainerNode,
  file: FileNode,
  symbol: SymbolNode,
  portal: PortalNode,
  cluster: ClusterNode,
  portalCluster: PortalClusterNode,
};

/**
 * One edge type for everything: `RoutedEdge` draws ELK's own obstacle-avoiding
 * route, and falls back to the previous smoothstep for any edge ELK gave no
 * route for.
 */
const edgeTypes: EdgeTypes = {
  routed: RoutedEdge,
};

/** Shared empty map so a route-less render doesn't churn the edge memo. */
const NO_ROUTES: ReadonlyMap<string, LayoutPoint[]> = new Map();

const EDGE_DASH: Partial<Record<EdgeKind, string>> = {
  imports: '7 5',
  references: '2 4',
  extends: '5 3',
  implements: '5 3',
};

/** One renderable edge after LOD re-targeting + portal merging. */
interface DisplayEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  count: number;
  portal: boolean;
}

/** One ghost node: an external symbol, or a roll-up of several from one parent. */
interface DisplayPortal {
  node: GraphNode;
  /** The rolled-up symbols' names, or undefined for a plain one-symbol ghost. */
  groupNames?: string[];
}

interface ViewModel {
  /** Real children rendered as full cards (post-LOD). */
  visible: GraphNode[];
  /** External symbols rendered as ghost portal nodes (post roll-up). */
  portals: DisplayPortal[];
  /** How many children collapsed into the "+N more" node (0 = none). */
  clusterCount: number;
  /** How many external SYMBOLS collapsed into the one ghost (0 = none). */
  portalCount: number;
  edges: DisplayEdge[];
}

function nodeWeight(node: GraphNode): number {
  return node.attrs?.symbolCount ?? node.attrs?.loc ?? 0;
}

/**
 * Roll external symbols up onto the declaration that contains them, whenever
 * one parent supplied more than one of them.
 *
 * Without this, "twenty symbols in store.ts reference types declared here"
 * draws twenty near-identical ghosts and twenty arrows, and a view about THIS
 * file becomes mostly a view about its neighbour. One ghost carrying a weighted
 * arrow says the same thing at this level of abstraction, and is exactly the
 * brief's aggregation rule (an edge at level N is the roll-up of level N+1)
 * applied across the view boundary instead of down it.
 *
 * A parent of ONE stays expanded: the per-symbol ghost is strictly more
 * informative and costs nothing, and it keeps the common view unchanged.
 *
 * Returns the id remapping (external symbol id -> ghost id) plus the ghosts.
 */
function rollUpPortals(
  graph: GraphViewResponse,
  keepId: string | null,
): {
  portals: DisplayPortal[];
  remap: Map<string, string>;
} {
  const parents = new Map(graph.externalParents.map((p) => [p.id, p]));
  const groups = new Map<string, GraphNode[]>();
  const loose: GraphNode[] = [];
  for (const external of graph.externalNodes) {
    const parentId = external.parentId;
    // No resolvable parent outside the view (the server only ships those) —
    // nothing to roll onto, so the symbol stays its own ghost.
    if (parentId === null || !parents.has(parentId)) {
      loose.push(external);
      continue;
    }
    const group = groups.get(parentId);
    if (group) group.push(external);
    else groups.set(parentId, [external]);
  }

  const portals: DisplayPortal[] = loose.map((node) => ({ node }));
  const remap = new Map<string, string>();
  for (const [parentId, members] of groups) {
    const parent = parents.get(parentId);
    // A landed-on/selected ghost must stay on screen as ITSELF — rolling it
    // into its parent would leave the view with nothing to centre or select.
    const holdsKeep = keepId !== null && members.some((m) => m.id === keepId);
    if (members.length < 2 || parent === undefined || holdsKeep) {
      for (const member of members) portals.push({ node: member });
      continue;
    }
    for (const member of members) remap.set(member.id, parentId);
    portals.push({ node: parent, groupNames: members.map((m) => m.name).sort() });
  }
  return { portals, remap };
}

/**
 * Apply level-of-detail and merge edges accordingly: edges touching clustered
 * nodes re-target the cluster node, edges touching a rolled-up external symbol
 * re-target its ghost, all deduped with counts summed. Portal edges keep their
 * own identity (they style differently).
 *
 * The cap is on RENDERED nodes, not on children: a ghost occupies the same
 * canvas and the same layout layer as a card, so counting only cards let a
 * 14-declaration file draw 46 nodes and fall below the label threshold. Ghosts
 * give way FIRST, in two steps — roll up onto shared parents, then collapse
 * wholesale past PORTAL_MAX_VISIBLE — because they are context, not content:
 * a view must not lose its own declarations to the crowd around it. Only then
 * do the smallest children collapse into "+N more".
 */
function buildViewModel(
  graph: GraphViewResponse,
  showAll: boolean,
  showPortals: boolean,
  keepId: string | null,
): ViewModel {
  const { portals, remap } = rollUpPortals(graph, keepId);

  // Ghost overflow: past the cap they all collapse into one counted ghost.
  // All of them, not a top-N — a partial wall is still a wall, and any cut-off
  // would have to justify why THESE twelve callers are the interesting ones.
  // The node a navigation just landed on is the one exception; it has to stay
  // on screen as itself for the canvas to centre and select it.
  const collapsedGhostIds = new Set<string>();
  let portalCount = 0;
  let shownPortals = portals;
  if (!showPortals && portals.length > PORTAL_MAX_VISIBLE) {
    shownPortals = [];
    for (const portal of portals) {
      if (portal.node.id === keepId) {
        shownPortals.push(portal);
        continue;
      }
      collapsedGhostIds.add(portal.node.id);
      // Count SYMBOLS, not ghosts: a roll-up ghost stands for several, and
      // "6 symbols" collapsing to "1" would be a lie about what's hidden.
      portalCount += portal.groupNames?.length ?? 1;
    }
  }
  const ghostSlots = shownPortals.length + (portalCount > 0 ? 1 : 0);

  let visible = graph.children;
  const clustered = new Set<string>();
  const childBudget = Math.max(1, LOD_MAX_VISIBLE - ghostSlots);
  if (!showAll && graph.children.length > childBudget) {
    const sorted = [...graph.children].sort((a, b) => nodeWeight(b) - nodeWeight(a));
    const keep = new Set(sorted.slice(0, childBudget - 1).map((n) => n.id));
    for (const child of graph.children) {
      if (!keep.has(child.id)) clustered.add(child.id);
    }
    // Never cluster away the node a navigation just landed on/selected.
    if (keepId !== null && clustered.has(keepId)) {
      clustered.delete(keepId);
      const smallestKept = [...sorted].reverse().find((n) => keep.has(n.id) && n.id !== keepId);
      if (smallestKept) {
        keep.delete(smallestKept.id);
        clustered.add(smallestKept.id);
      }
      keep.add(keepId);
    }
    visible = graph.children.filter((n) => !clustered.has(n.id));
  }

  const childIds = new Set(graph.children.map((c) => c.id));
  const portalIds = new Set(graph.externalNodes.map((n) => n.id));
  const mapEnd = (id: string): string => {
    if (clustered.has(id)) return CLUSTER_NODE_ID;
    // Roll-up first, THEN collapse: an external symbol reaches the collapsed
    // ghost through whichever parent ghost adopted it.
    const ghost = remap.get(id) ?? id;
    return collapsedGhostIds.has(ghost) ? PORTAL_CLUSTER_NODE_ID : ghost;
  };

  const merged = new Map<string, DisplayEdge>();
  const addEdge = (edge: { id: string; kind: EdgeKind; from: string; to: string; count: number }, portal: boolean): void => {
    const from = mapEnd(edge.from);
    const to = mapEnd(edge.to);
    if (from === to) return; // self-loops (incl. intra-cluster) add noise only
    const key = `${portal ? 'p' : 'e'}|${edge.kind}|${from}|${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += edge.count;
      existing.id = `agg:${key}`;
    } else {
      merged.set(key, { id: edge.id, kind: edge.kind, from, to, count: edge.count, portal });
    }
  };

  for (const edge of graph.edges) {
    if (childIds.has(edge.from) && childIds.has(edge.to)) addEdge(edge, false);
  }
  for (const edge of graph.externalEdges) {
    const fromKnown = childIds.has(edge.from) || portalIds.has(edge.from);
    const toKnown = childIds.has(edge.to) || portalIds.has(edge.to);
    if (fromKnown && toKnown) addEdge(edge, true);
  }

  // A view re-attributes a descendant's edge to the card that contains it, so
  // two edges the indexer knows are distinct (a method CALLS a helper, a
  // sibling REFERENCES the class) can land on the same pair of cards. Drawing
  // both paints a dotted line exactly on top of a solid one; the call is the
  // stronger statement, so it wins.
  for (const [key, edge] of [...merged]) {
    if (edge.kind !== 'references') continue;
    if (merged.has(`${edge.portal ? 'p' : 'e'}|calls|${edge.from}|${edge.to}`)) merged.delete(key);
  }

  return {
    visible,
    portals: shownPortals,
    clusterCount: clustered.size,
    portalCount,
    edges: [...merged.values()],
  };
}

/*
 * A card's links row reports the node's OWN links, which the server ships with
 * the view (`GraphViewResponse.linkCounts`) precisely so the row stays the same
 * set the expanded panel lists. Counting the drawn arrows here instead — which
 * this module used to do — makes the two disagree: a view merges parallel edges
 * into one arrow, re-attributes a descendant's edges to the card containing it,
 * and hides everything the LOD cluster swallowed. So there is no counting here
 * at all, only this fallback for a child the response somehow didn't count.
 */
const NO_LINKS: LinkCounts = { inCount: 0, outCount: 0 };

/**
 * The expansion applied to a node's dimensions, or null when collapsed.
 * Every real card (container/file/symbol) can expand; portals and the cluster
 * node cannot.
 */
function expansionFor(
  node: GraphNode,
  expandedIO: Record<string, boolean>,
  details: Record<string, NodeDetailResponse>,
): IOExpansion | null {
  if (expandedIO[node.id] !== true) return null;
  const detail = details[node.id];
  return detail
    ? { incoming: detail.incoming.length, outgoing: detail.outgoing.length }
    : { incoming: null, outgoing: null };
}

type ArrowDirection = 'up' | 'down' | 'left' | 'right';
const ARROW_KEYS: Record<string, ArrowDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** True when focus sits inside the right sidebar — its own controls own the keys. */
function isSidebarTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.sidebar') !== null;
}

function nodeCenter(node: AppNode): { x: number; y: number } {
  return {
    x: node.position.x + (node.width ?? 0) / 2,
    y: node.position.y + (node.height ?? 0) / 2,
  };
}

/** Spatially nearest node in `direction` from `from` (cone-weighted). */
function nearestInDirection(
  nodes: readonly AppNode[],
  from: AppNode,
  direction: ArrowDirection,
): AppNode | null {
  const origin = nodeCenter(from);
  let best: AppNode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of nodes) {
    if (candidate.id === from.id) continue;
    const center = nodeCenter(candidate);
    const dx = center.x - origin.x;
    const dy = center.y - origin.y;
    let primary: number;
    let ortho: number;
    switch (direction) {
      case 'right':
        primary = dx;
        ortho = Math.abs(dy);
        break;
      case 'left':
        primary = -dx;
        ortho = Math.abs(dy);
        break;
      case 'down':
        primary = dy;
        ortho = Math.abs(dx);
        break;
      case 'up':
        primary = -dy;
        ortho = Math.abs(dx);
        break;
    }
    if (primary <= 1) continue;
    const score = primary + ortho * 2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function GraphCanvasInner() {
  const top = useAppStore(selectTopEntry);
  const graph = useAppStore(selectCurrentGraph);
  const graphLoading = useAppStore((s) => s.graphLoading);
  const graphError = useAppStore((s) => s.graphError);
  const showAll = useAppStore((s) => selectTopEntry(s)?.showAll ?? false);
  const showPortals = useAppStore((s) => selectTopEntry(s)?.showPortals ?? false);
  const selectionId = useAppStore((s) => selectTopEntry(s)?.selectionId ?? null);
  const hoverId = useAppStore((s) => s.hoverId);
  const metaIndexing = useAppStore((s) => s.meta?.indexing ?? false);
  const indexProgress = useAppStore((s) => s.indexProgress);
  const select = useAppStore((s) => s.select);
  const drillInto = useAppStore((s) => s.drillInto);
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  const setShowAll = useAppStore((s) => s.setShowAll);
  const setShowPortals = useAppStore((s) => s.setShowPortals);
  const setHover = useAppStore((s) => s.setHover);
  const saveViewport = useAppStore((s) => s.saveViewport);

  const { setViewport, fitView, setCenter, getViewport } = useReactFlow<AppNode, AppEdge>();

  const direction: LayoutDirection = (top?.level ?? 1) >= 4 ? 'RIGHT' : 'DOWN';

  // The selection this view mounted with (portal/search landings): protected
  // from LOD clustering so the centered node is actually visible. Stable for
  // the lifetime of the canvas (which is keyed per view).
  const [mountSelectionId] = useState<string | null>(
    () => selectTopEntry(useAppStore.getState())?.selectionId ?? null,
  );

  const model = useMemo<ViewModel | null>(
    () => (graph ? buildViewModel(graph, showAll, showPortals, mountSelectionId) : null),
    [graph, showAll, showPortals, mountSelectionId],
  );

  // Expansion signature: relayout only when an expansion (or its row counts)
  // actually changes — not when unrelated node details get cached.
  const expandedIO = useAppStore((s) => s.expandedIO);
  const nodeDetails = useAppStore((s) => s.nodeDetails);
  const expansionSig = useMemo(() => {
    if (!model) return '';
    const parts: string[] = [];
    for (const child of model.visible) {
      const e = expansionFor(child, expandedIO, nodeDetails);
      if (e) parts.push(`${child.id}:${e.incoming ?? '?'}/${e.outgoing ?? '?'}`);
    }
    return parts.join('|');
  }, [model, expandedIO, nodeDetails]);

  // Layout inputs (sizes are pre-computed so ELK and fitView agree). Open
  // links panels grow their node so ELK re-layouts around the real size.
  const layoutInputs = useMemo<{
    nodes: LayoutNodeInput[] | null;
    edges: LayoutEdgeInput[] | null;
  }>(() => {
    if (!model) return { nodes: null, edges: null };
    const state = useAppStore.getState();
    const nodes: LayoutNodeInput[] = [
      ...model.visible.map((c) => ({
        id: c.id,
        ...nodeDimensions(c, expansionFor(c, state.expandedIO, state.nodeDetails)),
      })),
      ...model.portals.map((p) => ({
        id: p.node.id,
        ...portalDimensions(p.node, p.groupNames?.length),
      })),
      ...(model.clusterCount > 0 ? [{ id: CLUSTER_NODE_ID, ...clusterDimensions() }] : []),
      ...(model.portalCount > 0
        ? [{ id: PORTAL_CLUSTER_NODE_ID, ...portalClusterDimensions() }]
        : []),
    ];
    const edges: LayoutEdgeInput[] = model.edges.map((e) => ({ id: e.id, from: e.from, to: e.to }));
    return { nodes, edges };
    // expansionSig stands in for the expandedIO/nodeDetails slices used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, expansionSig]);

  const { positions, routes, layouting, error: layoutError } = useLayout(
    top?.nodeId ?? '',
    layoutInputs.nodes,
    layoutInputs.edges,
    direction,
  );

  const [nodes, setNodes] = useState<AppNode[]>([]);
  /**
   * Routes are held in state next to `nodes`, not read from `useLayout`
   * directly: both are published by the one apply effect below, so an edge can
   * never be drawn along a route computed for node positions that are not yet
   * on screen.
   */
  const [edgeRoutes, setEdgeRoutes] = useState<ReadonlyMap<string, LayoutPoint[]>>(NO_ROUTES);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  /**
   * "The user asked to see more nodes" — either cluster expanded. Both flags
   * only ever go false -> true, so a change is always a deliberate expansion.
   *
   * It has to be told apart from the OTHER same-view rebuild (the throttled
   * refetch while indexing streams), which must never move a camera the user
   * has taken. An expansion re-lays-out the whole graph around a much larger
   * node set: leaving the camera put there is how double-clicking the ghost
   * ends with the graph off screen entirely.
   */
  const revealSig = `${showAll}|${showPortals}`;
  const lastRevealRef = useRef(revealSig);

  // Read the entry via a ref inside effects so saving the viewport (which
  // patches the top entry) doesn't retrigger a rebuild + refit.
  const topRef = useRef<ViewEntry | undefined>(top);
  topRef.current = top;
  const nodesRef = useRef<AppNode[]>(nodes);
  nodesRef.current = nodes;

  // Viewport restore, applied once per (view, layout) build.
  const pendingViewportRef = useRef<{ restore: ViewEntry['viewport']; refresh: boolean } | null>(
    null,
  );
  const lastViewIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!model || !positions) return;
    const entry = topRef.current;
    const state = useAppStore.getState();
    const flowNodes: AppNode[] = [];
    for (const child of model.visible) {
      const dims = nodeDimensions(child, expansionFor(child, state.expandedIO, state.nodeDetails));
      const pos = positions.get(child.id) ?? { x: 0, y: 0 };
      flowNodes.push({
        id: child.id,
        type: cardVariantForKind(child.kind),
        position: { x: pos.x, y: pos.y },
        width: dims.width,
        height: dims.height,
        data: { node: child, direction, links: graph?.linkCounts[child.id] ?? NO_LINKS },
      });
    }
    for (const portal of model.portals) {
      const groupCount = portal.groupNames?.length;
      const dims = portalDimensions(portal.node, groupCount);
      const pos = positions.get(portal.node.id) ?? { x: 0, y: 0 };
      flowNodes.push({
        id: portal.node.id,
        type: 'portal',
        position: { x: pos.x, y: pos.y },
        width: dims.width,
        height: dims.height,
        data:
          groupCount !== undefined
            ? { node: portal.node, direction, groupCount, groupNames: portal.groupNames }
            : { node: portal.node, direction },
      });
    }
    if (model.clusterCount > 0) {
      const dims = clusterDimensions();
      const pos = positions.get(CLUSTER_NODE_ID) ?? { x: 0, y: 0 };
      flowNodes.push({
        id: CLUSTER_NODE_ID,
        type: 'cluster',
        position: { x: pos.x, y: pos.y },
        width: dims.width,
        height: dims.height,
        data: { count: model.clusterCount, direction },
      });
    }
    if (model.portalCount > 0) {
      const dims = portalClusterDimensions();
      const pos = positions.get(PORTAL_CLUSTER_NODE_ID) ?? { x: 0, y: 0 };
      flowNodes.push({
        id: PORTAL_CLUSTER_NODE_ID,
        type: 'portalCluster',
        position: { x: pos.x, y: pos.y },
        width: dims.width,
        height: dims.height,
        data: { count: model.portalCount, direction },
      });
    }
    setNodes(flowNodes);
    setEdgeRoutes(routes ?? NO_ROUTES);
    // Same-view rebuilds (throttled index refetch, cluster expand) must not
    // fight the user for the camera — only genuine view changes reset it.
    const viewId = entry?.nodeId ?? null;
    const viewChanged = lastViewIdRef.current !== viewId;
    lastViewIdRef.current = viewId;
    const revealChanged = lastRevealRef.current !== revealSig;
    lastRevealRef.current = revealSig;
    if (viewChanged || revealChanged) userInteractedRef.current = false;
    pendingViewportRef.current = {
      restore: entry?.viewport ?? null,
      refresh: !viewChanged && !revealChanged,
    };
  }, [model, positions, routes, direction, graph, revealSig]);

  // Hover neighborhood (adjacency over the displayed edges, portals included).
  const nodeIdSet = useMemo(() => {
    if (!model) return new Set<string>();
    const ids = new Set<string>();
    for (const n of model.visible) ids.add(n.id);
    for (const p of model.portals) ids.add(p.node.id);
    if (model.clusterCount > 0) ids.add(CLUSTER_NODE_ID);
    if (model.portalCount > 0) ids.add(PORTAL_CLUSTER_NODE_ID);
    return ids;
  }, [model]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!model) return map;
    for (const edge of model.edges) {
      let from = map.get(edge.from);
      if (!from) map.set(edge.from, (from = new Set()));
      from.add(edge.to);
      let to = map.get(edge.to);
      if (!to) map.set(edge.to, (to = new Set()));
      to.add(edge.from);
    }
    return map;
  }, [model]);

  /**
   * Dimming exists to show a NEIGHBORHOOD — which of these nodes the hovered
   * one touches. A node with no drawn links has no neighborhood, so there is
   * nothing for the dim to reveal: it would darken the entire view to say
   * "this one connects to nothing", which the card's own "0 in · 0 out" row
   * already says, in place, without hiding everything else.
   */
  const hoverNeighbors = hoverId === null ? undefined : adjacency.get(hoverId);
  const hoverActive =
    hoverId !== null && nodeIdSet.has(hoverId) && (hoverNeighbors?.size ?? 0) > 0;

  const renderNodes = useMemo<AppNode[]>(() => {
    const neighbors = hoverActive && hoverId !== null ? adjacency.get(hoverId) : undefined;
    return nodes.map((node) => {
      const dim =
        hoverActive && node.id !== hoverId && !(neighbors?.has(node.id) ?? false);
      return {
        ...node,
        selected: node.id === selectionId,
        className: dim ? 'node-dim' : undefined,
      };
    });
  }, [nodes, hoverActive, hoverId, adjacency, selectionId]);

  const renderEdges = useMemo<AppEdge[]>(() => {
    if (!model) return [];
    return model.edges.map((edge) => {
      const hot = hoverActive && (edge.from === hoverId || edge.to === hoverId);
      const dim = hoverActive && !hot;
      const labelled = edge.count > 1 && (hot || hoveredEdgeId === edge.id);
      // A portal is dimmed and ghosted by its class; its DASH still has to say
      // what kind of link it is, or every cross-file reference draws as a call.
      const dash = edge.portal ? (EDGE_DASH[edge.kind] ?? '4 4') : EDGE_DASH[edge.kind];
      const classNames = [
        edge.portal ? 'edge--portal' : '',
        hot ? 'edge--hot' : '',
        dim ? 'edge--dim' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const points = edgeRoutes.get(edge.id);
      const flowEdge: AppEdge = {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: 'routed',
        data: points !== undefined ? { points } : {},
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: hot ? 'var(--accent)' : 'var(--edge)',
        },
        style: {
          strokeWidth: 1 + Math.min(3, Math.log2(edge.count + 1)),
          ...(dash !== undefined ? { strokeDasharray: dash } : {}),
        },
      };
      if (classNames) flowEdge.className = classNames;
      if (labelled) {
        flowEdge.label = `×${edge.count}`;
        flowEdge.labelStyle = { fill: 'var(--edge-label)', fontSize: 10 };
        flowEdge.labelBgStyle = { fill: 'var(--bg-elevated)', fillOpacity: 0.9 };
        flowEdge.labelBgPadding = [4, 2];
        flowEdge.labelBgBorderRadius = 3;
      }
      return flowEdge;
    });
  }, [model, hoverActive, hoverId, hoveredEdgeId, edgeRoutes]);

  // True once the user has panned/zoomed by hand in the current view.
  const userInteractedRef = useRef(false);

  /** Persist the settled camera so Back and silent refetches restore it. */
  const savePostFitViewport = useCallback(() => {
    const entry = topRef.current;
    if (!entry || userInteractedRef.current || entry.viewport !== null) return;
    saveViewport(getViewport());
  }, [saveViewport, getViewport]);

  // Apply the saved viewport (exact Back restore), center a landed node, or
  // fit the fresh view. Gated on the pane having a real size — fitView on a
  // 0x0 pane silently produces a garbage transform. Node dimensions are
  // explicit, so no DOM measurement needs to be awaited.
  const paneReady = useFlowStore((s) => s.width > 0 && s.height > 0);
  useEffect(() => {
    const pending = pendingViewportRef.current;
    if (!pending || !paneReady || nodes.length === 0) return;
    pendingViewportRef.current = null;

    const store = useAppStore.getState();
    const centerId = store.pendingCenterId;
    const centerNode = centerId !== null ? nodes.find((n) => n.id === centerId) : undefined;
    if (centerId !== null) store.clearPendingCenter();

    // Same-view rebuild (throttled index refetch, cluster expand) while the
    // user has taken the camera: leave it exactly where they put it.
    if (pending.refresh && !centerNode && userInteractedRef.current) return;

    if (centerNode) {
      // Portal/search landing: center the target with a short animation.
      const { x, y } = nodeCenter(centerNode);
      void setCenter(x, y, { zoom: 1, duration: 200 }).then(savePostFitViewport);
      return;
    }
    const viewId = topRef.current?.nodeId;
    if (pending.restore) {
      // Back/breadcrumb: animate to the EXACT saved viewport (never fitView).
      // Same watchdog as below — if the transition is killed mid-flight,
      // land the exact restore instantly.
      const restore = pending.restore;
      let restored = false;
      void setViewport(restore, { duration: 200 }).then(() => {
        restored = true;
      });
      window.setTimeout(() => {
        if (!restored && !userInteractedRef.current && topRef.current?.nodeId === viewId) {
          void setViewport(restore);
        }
      }, 400);
      return;
    }
    // Fresh view: animated fit, with a watchdog. React's dev builds can kill
    // the underlying d3 transition mid-flight (node re-measurement races the
    // animation); if the fit never settles, land it instantly — a no-op when
    // the animation completed, and skipped once the user starts interacting.
    userInteractedRef.current = false;
    let settled = false;
    void fitView({ padding: 0.15, duration: 200 }).then(() => {
      settled = true;
      savePostFitViewport();
    });
    window.setTimeout(() => {
      if (!settled && !userInteractedRef.current && topRef.current?.nodeId === viewId) {
        void fitView({ padding: 0.15 }).then(savePostFitViewport);
      }
    }, 400);
  }, [nodes, paneReady, setViewport, fitView, setCenter, savePostFitViewport]);

  const onNodesChange = useCallback((changes: NodeChange<AppNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  /** Drill / expand / jump — shared by double-click and Enter. */
  const activateNode = useCallback(
    (node: AppNode) => {
      if (node.type === 'cluster') {
        setShowAll();
      } else if (node.type === 'portalCluster') {
        setShowPortals();
      } else if (node.type === 'portal') {
        // A rolled-up ghost IS the destination (a file/class), so open its own
        // view; a single-symbol ghost lands in its parent's view, centred.
        void navigateToNode(
          node.data.node.id,
          node.data.groupCount !== undefined ? undefined : { landOnParent: true },
        );
      } else {
        drillInto(node.data.node);
      }
    },
    [setShowAll, setShowPortals, navigateToNode, drillInto],
  );
  const activateRef = useRef(activateNode);
  activateRef.current = activateNode;

  // Keyboard: arrows move selection spatially, Enter drills into it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      if (isSidebarTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const state = useAppStore.getState();
      if (state.paletteOpen) return;

      if (event.key === 'Enter') {
        const selId = selectTopEntry(state)?.selectionId ?? null;
        if (selId === null) return;
        const node = nodesRef.current.find((n) => n.id === selId);
        if (!node) return;
        event.preventDefault();
        activateRef.current(node);
        return;
      }

      const arrow = ARROW_KEYS[event.key];
      if (!arrow) return;
      const all = nodesRef.current;
      if (all.length === 0) return;
      event.preventDefault();
      const selId = selectTopEntry(state)?.selectionId ?? null;
      const current = selId !== null ? all.find((n) => n.id === selId) : undefined;
      if (!current) {
        const first = all[0];
        if (first) state.select(first.id);
        return;
      }
      const next = nearestInDirection(all, current, arrow);
      if (next) state.select(next.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Zoom level-of-detail, two tiers (CSS-driven). Cards now carry 4-6 rows,
  // so the old all-or-nothing threshold either rendered 4px text or blanked
  // the card entirely. The dim tier starts where hiding used to, so this can
  // only add detail: 0.2-0.34 keeps the glyph + name, and full detail still
  // appears at exactly the zoom it did before.
  const zoom = useFlowStore((s) => s.transform[2]);
  const lod = zoom < 0.2 ? ' labels-hidden' : zoom < 0.34 ? ' labels-dim' : '';

  const indexing = indexProgress !== null || metaIndexing;
  const showEmpty =
    graph !== undefined && !graphLoading && !layouting && graph.children.length === 0;

  return (
    <div className={`graph-canvas${lod}`}>
      <ReactFlow<AppNode, AppEdge>
        nodes={renderNodes}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => select(node.id)}
        onNodeDoubleClick={(_event, node) => activateNode(node)}
        onNodeMouseEnter={(_event, node) => setHover(node.id)}
        onNodeMouseLeave={() => setHover(null)}
        onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdgeId(null)}
        onPaneClick={() => select(null)}
        onMoveStart={(event) => {
          if (event) userInteractedRef.current = true;
        }}
        onMoveEnd={(_event, viewport) => saveViewport(viewport)}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        disableKeyboardA11y
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} />
      </ReactFlow>
      {/* "Laying out…" explains an EMPTY canvas. Once cards are on screen
          there is nothing left to explain, and showing it anyway made the
          throttled refetch during indexing pulse a spinner over a perfectly
          readable graph every couple of seconds. */}
      {graphLoading || (layouting && nodes.length === 0) ? (
        <div className="canvas-overlay">
          <span className="spinner" aria-hidden />
          <span>{graphLoading ? 'Loading view…' : 'Laying out…'}</span>
        </div>
      ) : null}
      {graphError !== null || layoutError !== null ? (
        <div className="canvas-overlay">
          <span>{graphError ?? layoutError}</span>
        </div>
      ) : null}
      {showEmpty ? (
        indexing ? (
          <div className="canvas-overlay canvas-overlay--hero">
            <span className="spinner spinner--large" aria-hidden />
            <span className="hero-title">Indexing…</span>
            <span className="hero-sub">
              {indexProgress
                ? `${indexProgress.phase} — ${indexProgress.filesDone}/${indexProgress.filesTotal} files`
                : 'building the graph — the view fills in as results stream'}
            </span>
          </div>
        ) : (
          <div className="canvas-overlay canvas-overlay--empty">
            <span>Nothing here yet — this view has no indexed children.</span>
          </div>
        )
      ) : null}
    </div>
  );
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner />
    </ReactFlowProvider>
  );
}
