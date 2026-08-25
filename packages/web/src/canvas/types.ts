import type { GraphNode, NodeKind } from '@lsp-viz/core';
import type { Edge, Node } from '@xyflow/react';
import type { LayoutDirection } from '../layout/messages';

/** Data payload shared by graph-backed canvas nodes (incl. portals). */
export type CanvasNodeData = {
  node: GraphNode;
  /** Current layout direction — positions the (invisible) edge handles. */
  direction: LayoutDirection;
  /** Incoming displayed-edge count in the CURRENT view (badge + popover). */
  viewIn: number;
  /** Outgoing displayed-edge count in the CURRENT view (badge + popover). */
  viewOut: number;
};

/** Data for the synthetic "+N more" cluster node. */
export type ClusterNodeData = {
  count: number;
  direction: LayoutDirection;
};

export type ContainerFlowNode = Node<CanvasNodeData, 'container'>;
export type FileFlowNode = Node<CanvasNodeData, 'file'>;
export type SymbolFlowNode = Node<CanvasNodeData, 'symbol'>;
export type PortalFlowNode = Node<CanvasNodeData, 'portal'>;
export type ClusterFlowNode = Node<ClusterNodeData, 'cluster'>;

export type AppNode =
  | ContainerFlowNode
  | FileFlowNode
  | SymbolFlowNode
  | PortalFlowNode
  | ClusterFlowNode;
export type AppEdge = Edge;

/** Synthetic id of the single "+N more" LOD cluster node. */
export const CLUSTER_NODE_ID = '__lsp_viz_cluster__';

/** Max nodes rendered per view before the smallest collapse into a cluster. */
export const LOD_MAX_VISIBLE = 50;

/** Which custom node component renders a graph node of this kind. */
export function nodeTypeForKind(kind: NodeKind): 'container' | 'file' | 'symbol' {
  switch (kind) {
    case 'workspace':
    case 'package':
    case 'directory':
      return 'container';
    case 'file':
      return 'file';
    default:
      return 'symbol';
  }
}

export interface NodeDimensions {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* In/out expansion panel geometry — MUST stay in sync with the .node-io CSS
 * so ELK's node sizes match what the DOM renders. */
export const IO_ROW_HEIGHT = 22;
export const IO_SECTION_HEAD = 17;
export const IO_MAX_ROWS = 8;
/** border + margin + padding above the panel body. */
const IO_PANEL_OVERHEAD = 8;
/** height of the single "loading…" / "no direct links" note row + overhead. */
const IO_PANEL_NOTE = 30;

/** Facts block rows: path + optional metrics line. */
const FACT_ROW = 15;
/** One wrapped line of the monospace signature block. */
const FACT_SIG_LINE = 14;
/** Signature block is clamped to this many lines (matches the CSS clamp). */
const FACT_SIG_MAX_LINES = 4;
/** Approximate chars per line of the signature block at EXPANDED_MIN_WIDTH. */
const FACT_SIG_CHARS = 34;

/**
 * Row counts for an expanded in/out panel. `null` counts mean the node detail
 * is still loading (the panel shows a one-line note).
 */
export interface IOExpansion {
  incoming: number | null;
  outgoing: number | null;
}

/** Height of the extended-fields block shown at the top of an open card. */
function factsHeight(node: GraphNode): number {
  let height = 6; // block padding
  if (node.path !== '') height += FACT_ROW;
  const signature = node.signature;
  if (signature !== undefined && signature !== '') {
    const lines = Math.min(FACT_SIG_MAX_LINES, Math.ceil(signature.length / FACT_SIG_CHARS));
    height += lines * FACT_SIG_LINE + 4;
  }
  const attrs = node.attrs;
  const hasMeta =
    attrs !== undefined &&
    (attrs.loc !== undefined ||
      attrs.symbolCount !== undefined ||
      attrs.exportCount !== undefined ||
      attrs.entry === true);
  if (hasMeta) height += FACT_ROW;
  return height;
}

/** Extra card height contributed by an open panel (facts + links). */
export function ioPanelHeight(node: GraphNode, expansion: IOExpansion): number {
  const facts = factsHeight(node);
  if (expansion.incoming === null || expansion.outgoing === null) {
    return facts + IO_PANEL_NOTE;
  }
  const section = (rows: number): number =>
    rows > 0 ? IO_SECTION_HEAD + Math.min(rows, IO_MAX_ROWS) * IO_ROW_HEIGHT + 4 : 0;
  const body = section(expansion.incoming) + section(expansion.outgoing);
  return facts + (body === 0 ? IO_PANEL_NOTE : body + IO_PANEL_OVERHEAD);
}

/** Extra height of the one-line signature strip on symbol cards. */
const SIGNATURE_STRIP = 16;
/** Minimum width of a card whose in/out panel is open. */
const EXPANDED_MIN_WIDTH = 250;

/**
 * Pre-computed node dimensions (ELK needs them, and explicit sizes let React
 * Flow fit the view without waiting for DOM measurement). Size encodes
 * symbolCount for containers and loc for files, per BRIEF. `expansion` is the
 * node's open in/out panel (file/symbol cards only) — passing it grows the
 * card so ELK re-layouts around the expanded size.
 */
export function nodeDimensions(node: GraphNode, expansion?: IOExpansion | null): NodeDimensions {
  const nameWidth = node.name.length * 7.2;
  const open = expansion != null;
  // The collapsed summary rows are replaced by the panel when open.
  const extra = open ? ioPanelHeight(node, expansion) : 0;
  switch (nodeTypeForKind(node.kind)) {
    case 'container': {
      const symbolCount = node.attrs?.symbolCount ?? 0;
      const scale = 1 + clamp(Math.log10(symbolCount + 1) * 0.12, 0, 0.4);
      const width = Math.round(clamp(nameWidth + 90, 190, 300) * scale);
      return {
        width: open ? Math.max(width, EXPANDED_MIN_WIDTH) : width,
        height: open ? Math.round(46 * scale) + extra : Math.round(76 * scale),
      };
    }
    case 'file': {
      const loc = node.attrs?.loc ?? 0;
      const scale = 1 + clamp(Math.log10(loc + 1) * 0.08, 0, 0.3);
      const width = Math.round(clamp(nameWidth + 100, 200, 300) * scale);
      return {
        width: open ? Math.max(width, EXPANDED_MIN_WIDTH) : width,
        height: open ? Math.round(62 * scale) + extra : Math.round(92 * scale),
      };
    }
    case 'symbol': {
      const width = Math.round(clamp(nameWidth + 70, 140, 280));
      const head = node.kind === 'class' || node.kind === 'interface' ? 54 : 46;
      const signed = node.signature !== undefined && node.signature !== '';
      return {
        width: open ? Math.max(width, EXPANDED_MIN_WIDTH) : width,
        height: open ? head + extra : head + (signed ? SIGNATURE_STRIP : 0),
      };
    }
  }
}

/** Small ghost card: name row + file path row. */
export function portalDimensions(node: GraphNode): NodeDimensions {
  const nameWidth = node.name.length * 6.6 + 44;
  const pathWidth = node.path.length * 5.2 + 20;
  return {
    width: Math.round(clamp(Math.max(nameWidth, Math.min(pathWidth, 190)), 130, 230)),
    height: 44,
  };
}

export function clusterDimensions(): NodeDimensions {
  return { width: 156, height: 52 };
}
