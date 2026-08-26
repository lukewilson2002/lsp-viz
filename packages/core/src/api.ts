/**
 * Shared HTTP/WebSocket API shapes. The server produces these, the web app
 * consumes them (via `import type` only — this package's runtime must never be
 * bundled into the frontend).
 */

import type { GraphEdge, GraphNode, NodeKind } from './types.js';

/**
 * How many links a node has, in each direction. Always the LENGTHS of the
 * `incoming`/`outgoing` lists {@link NodeDetailResponse} carries for the same
 * node — one definition of "a node's links", so a summary can never disagree
 * with the list it summarises.
 */
export interface LinkCounts {
  inCount: number;
  outCount: number;
}

/** GET /api/graph?parent=<nodeId> */
export interface GraphViewResponse {
  parent: GraphNode;
  children: GraphNode[];
  /** Edges among `children` (fine-grained + aggregated, endpoints remapped to children). */
  edges: GraphEdge[];
  /**
   * Edges with exactly one endpoint among `children` (symbol views only) —
   * these power portal nodes. The in-view endpoint is a child id, the other
   * endpoint is an id found in `externalNodes`.
   */
  externalEdges: GraphEdge[];
  externalNodes: GraphNode[];
  /**
   * The declaration each `externalNodes` entry lives in — its `parentId`,
   * resolved, deduped, and only for parents outside this view.
   *
   * A view draws one ghost per external SYMBOL, which is right until a single
   * neighbouring file supplies twenty of them and the view is mostly ghosts.
   * The aggregation rule ("an edge at level N is the roll-up of edges at level
   * N+1") says those roll up onto the thing that contains them, so the client
   * needs the containers as real nodes — real ids, so selecting and drilling
   * into a rolled-up ghost resolves server-side like any other node.
   */
  externalParents: GraphNode[];
  /**
   * Link counts for each entry of `children`, keyed by node id (every child is
   * present, zeros included; `externalNodes` are NOT — a portal is a pointer,
   * not a card with a links row).
   *
   * These are the node's OWN links as GET /api/node/:id reports them, not the
   * edges this view happens to draw. The two differ legitimately — the view
   * merges parallel edges into one arrow and remaps descendant edges onto the
   * child that contains them — so a card that headlines one number and expands
   * to the other list contradicts itself. Serving the counts alongside the
   * graph keeps the card honest without a fetch per card.
   */
  linkCounts: Record<string, LinkCounts>;
}

/**
 * One resolved link and the node at its far end.
 *
 * The name is a historical misnomer kept for compatibility: `edge.kind` is any
 * link kind the far end can carry — `references`, `extends` and `implements`
 * alongside `calls` for symbols, `imports` for files, aggregate roll-ups for
 * containers. UI that renders these lists must stay link-neutral in its
 * wording ("uses", not "calls"): a constant nothing CALLS is still used by the
 * function whose default parameter reads it.
 */
export interface CallLink {
  edge: GraphEdge;
  node: GraphNode;
}

/** GET /api/node/:id */
export interface NodeDetailResponse {
  node: GraphNode;
  /** [root, ..., direct parent] — powers breadcrumb reconstruction. */
  ancestors: GraphNode[];
  /** Call/reference edges into this node, with the far-end node resolved. */
  incoming: CallLink[];
  outgoing: CallLink[];
  metrics: LinkCounts & {
    childCount: number;
  };
}

/** GET /api/source/:id */
export interface SourceResponse {
  /** Repo-relative path. */
  path: string;
  language: string;
  /** 1-based line number of the first line of `text` in the real file. */
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * One clickable identifier in a source view: every occurrence of `name` in the
 * slice navigates to `nodeId`.
 */
export interface SourceLink {
  name: string;
  nodeId: string;
}

/**
 * GET /api/links/:id — the identifiers a node's source slice may link, resolved
 * server-side in one store pass.
 *
 * The client cannot compute this: a file's own outgoing edges are `imports`
 * between FILE nodes, so the only names it could offer are basenames like
 * `index.ts` — which is why no file source view has ever had a link. Resolving
 * here also lets ambiguity be settled once, against the whole store: `name` is
 * unique across `links`, and a name owned by two different declarations is
 * dropped rather than guessed, because a link that jumps to the wrong symbol is
 * worse than no link and the only undo is Back.
 */
export interface SourceLinksResponse {
  /** Echo of the requested node id. */
  nodeId: string;
  /** Unique by `name`. */
  links: SourceLink[];
}

/** GET /api/search?q= */
export interface SearchResult {
  node: GraphNode;
  score: number;
}
export interface SearchResponse {
  results: SearchResult[];
}

export type IndexPhase = 'structural' | 'semantic' | 'aggregate';

export interface IndexStats {
  files: number;
  nodes: number;
  edges: number;
  durationMs: number;
}

/** POST /api/index body. */
export interface IndexRequestBody {
  /** Force a full re-index instead of an mtime diff. */
  full?: boolean;
}

/** Messages streamed on WebSocket /ws (server -> client). */
export type WsServerMessage =
  | {
      type: 'index:progress';
      phase: IndexPhase;
      filesDone: number;
      filesTotal: number;
      currentFile?: string;
      symbols?: number;
      callEdges?: number;
    }
  | { type: 'index:done'; stats: IndexStats }
  | { type: 'index:error'; message: string };

/**
 * GET /api/tree — the repo's containment tree (containers + files, no
 * symbols), for the sidebar directory tree.
 */
export interface TreeNode {
  id: string;
  name: string;
  kind: GraphNode['kind'];
  path: string;
  /** Present only on containers; files are leaves. */
  children?: TreeNode[];
}
export interface TreeResponse {
  root: TreeNode;
}

/**
 * One declaration inside a {@link SymbolFileGroup}, flattened in source order.
 * Nesting (a method inside a class) is expressed by `depth`, not by a children
 * array: the sidebar renders an indented list, and a flat array makes the
 * response cap deterministic.
 */
export interface SymbolEntry {
  /** GraphNode id — feed straight to navigateToNode(). */
  id: string;
  kind: NodeKind;
  name: string;
  /** 0 for a top-level declaration, 1 for a class member, 2 for a nested member... */
  depth: number;
}

/** Every declaration of one file, in source order. */
export interface SymbolFileGroup {
  /** The declaring file node's id — the group header is itself navigable. */
  fileId: string;
  /** Basename of `path`. */
  name: string;
  /** Repo-relative path of the declaring file. */
  path: string;
  /**
   * `path` relative to the REQUESTED node's path — what the sidebar shows as
   * the group subtitle. '' when the group IS the requested node's own file.
   */
  relativePath: string;
  symbols: SymbolEntry[];
  /** Declarations of this file dropped by the response cap (0 when complete). */
  omitted: number;
}

/**
 * GET /api/symbols/:id — the declarations in or under a node, grouped by the
 * file that declares them. Powers the sidebar Details tab's symbol list.
 */
export interface SymbolsResponse {
  /** Echo of the requested node id. */
  nodeId: string;
  /**
   * How the scope was derived from the node's kind:
   *  'descendants' — workspace/package/directory: every declaration beneath it,
   *  'file'        — a file node: its own declarations, nested members included,
   *  'members'     — a symbol node (class/interface/...): its nested members.
   */
  scope: 'descendants' | 'file' | 'members';
  /** Non-empty groups only, sorted by `path`. */
  groups: SymbolFileGroup[];
  /** Files in scope that declare at least one symbol, BEFORE the group cap. */
  totalFiles: number;
  /** Declarations in scope, BEFORE the entry cap. */
  totalSymbols: number;
  /** True when `groups` omits whole files and/or individual symbols. */
  truncated: boolean;
}

/** GET /api/meta */
export interface MetaResponse {
  repoRoot: string;
  repoName: string;
  indexedAt: string | null;
  indexing: boolean;
  stats: { nodes: number; edges: number; files: number };
}
