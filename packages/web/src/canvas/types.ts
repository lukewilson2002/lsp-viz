/**
 * Canvas node/edge types and the GEOMETRY the layout runs on.
 *
 * ELK (and React Flow, which takes the ELK size verbatim) must know how big a
 * card is before the card exists in the DOM, so every size here is an estimate
 * of what the browser will do. Two rules keep that honest:
 *
 *  1. WHICH rows a card renders is decided once, in `cardModel.ts`. This module
 *     measures the `CardRows` that `NodeCard` renders — it never re-derives them.
 *  2. HOW TALL each row is duplicates the `.node-card*` / `.node-io*` rules in
 *     styles.css. Each constant below names the rule it mirrors; change one and
 *     you must change the other. `.node-card` is `overflow: hidden` at a height
 *     it does not control, so an under-estimate CLIPS a row — every estimate
 *     here rounds up.
 */

import type { GraphNode, LinkCounts } from '@lsp-viz/core';
import type { Edge, Node } from '@xyflow/react';
import type { LayoutDirection, LayoutPoint } from '../layout/messages';
import { cardRows, formatCardPath } from './cardModel';
import type { CardRows } from './cardModel';

/** Data payload shared by the three graph-backed CARD nodes. */
export type CanvasNodeData = {
  node: GraphNode;
  /** Current layout direction — positions the (invisible) edge handles. */
  direction: LayoutDirection;
  /**
   * The node's own link counts, straight from `/api/graph`'s `linkCounts` —
   * the very set `/api/node/:id` enumerates, so the links row's summary and
   * the list it expands to can never disagree. Deliberately NOT the count of
   * arrows this view draws: the view merges parallel edges and re-attributes
   * descendants' edges to the card that contains them.
   */
  links: LinkCounts;
};

/** Portals are a two-row ghost with no links row, so they carry no counts. */
export type PortalNodeData = {
  /** The external symbol, or — when `groupCount` is set — the file/class holding them. */
  node: GraphNode;
  direction: LayoutDirection;
  /**
   * How many external symbols this ONE ghost stands for, when a single
   * neighbouring declaration supplied more than one. Absent for the ordinary
   * one-symbol ghost. `node` is a real graph node either way, so selecting or
   * activating a rolled-up ghost behaves like any other node.
   */
  groupCount?: number;
  /** Names of those symbols — the roll-up is summarised, never hidden (tooltip). */
  groupNames?: string[];
};

/**
 * Data for the two synthetic count-only nodes: the "+N more" LOD cluster and
 * the collapsed portal ghost. Same shape, different node types — what each
 * count MEANS (hidden children vs. external symbols) is the component's.
 */
export type ClusterNodeData = {
  count: number;
  direction: LayoutDirection;
};

export type ContainerFlowNode = Node<CanvasNodeData, 'container'>;
export type FileFlowNode = Node<CanvasNodeData, 'file'>;
export type SymbolFlowNode = Node<CanvasNodeData, 'symbol'>;
export type PortalFlowNode = Node<PortalNodeData, 'portal'>;
export type ClusterFlowNode = Node<ClusterNodeData, 'cluster'>;
export type PortalClusterFlowNode = Node<ClusterNodeData, 'portalCluster'>;

export type AppNode =
  | ContainerFlowNode
  | FileFlowNode
  | SymbolFlowNode
  | PortalFlowNode
  | ClusterFlowNode
  | PortalClusterFlowNode;

/**
 * Every edge on the canvas is a `RoutedEdge`. `points` is ELK's own route for
 * it, in the same coordinate space as the node positions; absent when ELK
 * returned no sections for the edge, in which case the component falls back to
 * the smoothstep that was drawn before routes were read back.
 */
export type RoutedEdgeData = {
  points?: LayoutPoint[];
};

export type RoutedFlowEdge = Edge<RoutedEdgeData, 'routed'>;
export type AppEdge = RoutedFlowEdge;

/** Synthetic id of the single "+N more" LOD cluster node. */
export const CLUSTER_NODE_ID = '__lsp_viz_cluster__';

/** Synthetic id of the single collapsed "N external symbols" ghost. */
export const PORTAL_CLUSTER_NODE_ID = '__lsp_viz_portal_cluster__';

/** True for the synthetic nodes — the ones with no graph node behind them. */
export function isSyntheticNodeId(id: string): boolean {
  return id === CLUSTER_NODE_ID || id === PORTAL_CLUSTER_NODE_ID;
}

/** Max nodes rendered per view before the smallest collapse into a cluster. */
export const LOD_MAX_VISIBLE = 50;

/**
 * Max ghost nodes drawn before they collapse into one counted ghost.
 *
 * Ghosts are CONTEXT — "this is used from outside" — and a file used by forty
 * unrelated callers was rendering forty of them: a wall down one side of the
 * view, none of it about the file being looked at, and (because ghosts and
 * cards share one node budget) it also pushed the file's own declarations
 * into "+N more". Past this many, one ghost states the count and the view
 * goes back to being about its own contents; double-click still expands them
 * all. Twelve is roughly what fits beside a view without dominating it.
 */
export const PORTAL_MAX_VISIBLE = 12;

export interface NodeDimensions {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Row counts for an expanded links panel. `null` counts mean the node detail
 * is still loading (the panel shows a one-line note).
 */
export interface IOExpansion {
  incoming: number | null;
  outgoing: number | null;
}

/* ---- card geometry — mirrors the .node-card* rules in styles.css.
 * Over-reserving leaves harmless slack at the bottom of a flex-start card;
 * under-reserving clips a row (see the module header). `box-sizing:
 * border-box` is global, so borders are inside the reserved width/height. ---- */

const CARD_PAD_X = 10; // .node-card padding-inline
const CARD_PAD_Y = 8; // .node-card padding-block (each side)
/**
 * .node-card border, top + bottom. `box-sizing: border-box` is global, so the
 * height React Flow applies INCLUDES these two pixels — leave them out and
 * every card is 2px short of its own rows. Flex then takes those 2px from the
 * one row that can give (the signature, the only `overflow: hidden` child),
 * which reads as a clipped last line on a card that measures correctly.
 */
const CARD_BORDER = 2;
const GLYPH_W = 11; // .node-card-head .kind-glyph width (flex: none)
const HEAD_GAP = 6; // .node-card-head gap
const ENTRY_BADGE_W = 46; // .entry-badge pill (~40px) + 6px gap
const NAME_CHAR_PX = 7.2; // avg advance: 13px/600 UI ≈ 12px mono
const NAME_SAFETY = 6; // bias the wrap estimate UP
const NAME_LINE = 17; // .node-card-name line-height
const NAME_MAX_LINES = 2; // == -webkit-line-clamp
const SIG_MARGIN = 3; // .node-card-signature margin-top
const SIG_BOX_PAD_Y = 6; // padding 2px x2 + border 1px x2
const SIG_BOX_PAD_X = 12; // padding 5px x2 + border 1px x2
const SIG_CHAR_PX = 6.2; // 10px mono advance (measured 6.15 — round UP)
const SIG_LINE = 13; // .node-card-signature line-height
/**
 * == -webkit-line-clamp. Two lines cut nearly every real signature in half —
 * a return type is the last thing on the line and the first thing lost. Six
 * at 9.5px shows a ~280-character declaration whole, which covers all but the
 * most generic-heavy ones, and a card only pays for the lines it uses.
 */
const SIG_MAX_LINES = 6;
const PATH_ROW = 16; // margin-top 2 + line-height 14
const FACTS_ROW = 15; // margin-top 2 + line-height 13
const EXPORTS_ROW = 15; // margin-top 2 + line-height 13
const LINKS_ROW = 21; // margin-top 3 + height 18

const CARD_MIN_W: Record<CardRows['variant'], number> = { container: 200, file: 210, symbol: 180 };
const CARD_MAX_W: Record<CardRows['variant'], number> = { container: 340, file: 340, symbol: 300 };
const CARD_MAX_SCALED_W = 380;
/** Minimum width of a card whose links panel is open. */
const EXPANDED_MIN_W = 260;

/* ---- expanded links panel — MUST mirror .node-io* ---- */
export const IO_ROW_HEIGHT = 22;
export const IO_MAX_ROWS = 8;
/** .node-io-label 13px line + 4px margin-bottom. */
export const IO_SECTION_HEAD = 17;
/** .node-io margin-top 3 + border-top 1 + padding-top 3. */
const IO_PANEL_TOP = 7;
/** .node-io-section margin-bottom. */
const IO_SECTION_GAP = 4;
/** .node-io-note height (both the loading and the empty note). */
const IO_NOTE_ROW = 22;

function nameLineCount(rows: CardRows, width: number): number {
  const entryW = rows.entry ? ENTRY_BADGE_W : 0;
  const nameBox = Math.max(40, width - CARD_PAD_X * 2 - GLYPH_W - HEAD_GAP - entryW);
  const nameW = rows.name.length * NAME_CHAR_PX;
  return Math.min(NAME_MAX_LINES, Math.max(1, Math.ceil((nameW + NAME_SAFETY) / nameBox)));
}

/**
 * Lines one hard line of text wraps to in a box `perLine` characters wide.
 *
 * Greedy, word by word, because that is what the browser does: `length /
 * perLine` assumes text packs perfectly to the right edge, and real wrapped
 * text does not — every line ends early at the last word that fit. On a
 * 25-character box, `(method) HubCache.compactNode(node: ICachedNode):
 * ICompactNode` takes four lines, not the three that division predicts, and
 * a signature short by one line is a signature with its return type cut off.
 *
 * `overflow-wrap: anywhere` is the second case: a word longer than the whole
 * box is split across lines rather than overflowing.
 */
function wrappedLineCount(text: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  // Trailing space stays with its word — a break opportunity is AFTER a space.
  for (const word of text.split(/(?<=\s)/)) {
    if (used + word.length <= perLine) {
      used += word.length;
      continue;
    }
    if (used > 0) {
      lines++;
      used = 0;
    }
    if (word.length <= perLine) {
      used = word.length;
      continue;
    }
    const overflowLines = Math.ceil(word.length / perLine) - 1;
    lines += overflowLines;
    used = word.length - overflowLines * perLine;
  }
  return lines;
}

function signatureLineCount(signature: string, width: number): number {
  const box = Math.max(40, width - CARD_PAD_X * 2 - SIG_BOX_PAD_X);
  const perLine = Math.max(8, Math.floor(box / SIG_CHAR_PX));
  // white-space: pre-wrap keeps explicit newlines, so wrapping is counted
  // PER hard line: taking the max of the two (as this did while the clamp was
  // 2) under-reserves a signature that both breaks and wraps, and an
  // under-reserved row is a clipped one.
  let lines = 0;
  for (const line of signature.split('\n')) lines += wrappedLineCount(line, perLine);
  return Math.min(SIG_MAX_LINES, Math.max(1, lines));
}

function cardWidth(rows: CardRows, scale: number): number {
  const entryW = rows.entry ? ENTRY_BADGE_W : 0;
  const desired = CARD_PAD_X * 2 + GLYPH_W + HEAD_GAP + entryW + rows.name.length * NAME_CHAR_PX;
  const base = clamp(desired, CARD_MIN_W[rows.variant], CARD_MAX_W[rows.variant]);
  return Math.round(Math.min(base * scale, CARD_MAX_SCALED_W));
}

function collapsedHeight(rows: CardRows, width: number): number {
  let h = CARD_PAD_Y * 2 + CARD_BORDER;
  h += nameLineCount(rows, width) * NAME_LINE;
  if (rows.signature !== null) {
    h += SIG_MARGIN + SIG_BOX_PAD_Y + signatureLineCount(rows.signature, width) * SIG_LINE;
  }
  if (rows.path !== null) h += PATH_ROW;
  if (rows.facts !== null) h += FACTS_ROW;
  if (rows.exports !== null) h += EXPORTS_ROW;
  h += LINKS_ROW;
  return h;
}

/** Extra card height contributed by an open links panel. */
export function linksPanelHeight(expansion: IOExpansion): number {
  if (expansion.incoming === null || expansion.outgoing === null) {
    return IO_PANEL_TOP + IO_NOTE_ROW; // "loading links…"
  }
  const section = (n: number): number =>
    n > 0 ? IO_SECTION_HEAD + Math.min(n, IO_MAX_ROWS) * IO_ROW_HEIGHT + IO_SECTION_GAP : 0;
  const body = section(expansion.incoming) + section(expansion.outgoing);
  return IO_PANEL_TOP + (body === 0 ? IO_NOTE_ROW : body); // "no links for this <kind>"
}

/**
 * Pre-computed node dimensions (ELK needs them, and explicit sizes let React
 * Flow fit the view without waiting for DOM measurement). Every card now
 * carries its full row stack unconditionally, so the height is derived from
 * the rows rather than from a per-kind constant; BRIEF's size-encodes-weight
 * rule applies to WIDTH only, since scaling a content-derived height clips it.
 * `expansion` is the node's open links panel — passing it grows the card so
 * ELK re-layouts around the open size.
 */
export function nodeDimensions(node: GraphNode, expansion?: IOExpansion | null): NodeDimensions {
  const rows = cardRows(node);
  const attrs = node.attrs;
  const scale =
    rows.variant === 'container'
      ? 1 + clamp(Math.log10((attrs?.symbolCount ?? 0) + 1) * 0.12, 0, 0.4)
      : rows.variant === 'file'
        ? 1 + clamp(Math.log10((attrs?.loc ?? 0) + 1) * 0.08, 0, 0.3)
        : 1;
  const base = cardWidth(rows, scale);
  // Width must be FINAL before collapsedHeight runs — the name wrap count
  // depends on it. Expanding a narrow symbol card can drop its name from 2
  // lines to 1; that is correct, since ELK and the DOM see the same width.
  const width = expansion != null ? Math.max(base, EXPANDED_MIN_W) : base;
  return {
    width,
    height: collapsedHeight(rows, width) + (expansion != null ? linksPanelHeight(expansion) : 0),
  };
}

/**
 * Small ghost card: name row + location row. The location row is measured
 * through `formatCardPath` — the same string PortalNode renders — so a portal
 * is sized for `file.ts:42`, not for the full repo-relative path it used to
 * show.
 */
export function portalDimensions(node: GraphNode, groupCount?: number): NodeDimensions {
  const nameWidth = node.name.length * 6.6 + 44;
  // A rolled-up ghost shows "N symbols" on the location row instead of a
  // line number, so it is measured for that string, not for the path.
  const second =
    groupCount !== undefined ? `${groupCount} symbols` : (formatCardPath(node) ?? node.path);
  const pathWidth = second.length * 5.2 + 20;
  return {
    width: Math.round(clamp(Math.max(nameWidth, Math.min(pathWidth, 190)), 130, 230)),
    height: 44,
  };
}

export function clusterDimensions(): NodeDimensions {
  return { width: 156, height: 52 };
}

/** Wider than the LOD cluster: it carries a count AND what the count is of. */
export function portalClusterDimensions(): NodeDimensions {
  return { width: 200, height: 56 };
}
