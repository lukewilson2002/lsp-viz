/**
 * Shared HTTP/WebSocket API shapes. The server produces these, the web app
 * consumes them (via `import type` only — this package's runtime must never be
 * bundled into the frontend).
 */

import type { GraphEdge, GraphNode } from './types.js';

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
}

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
  metrics: {
    inCount: number;
    outCount: number;
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

/** GET /api/meta */
export interface MetaResponse {
  repoRoot: string;
  repoName: string;
  indexedAt: string | null;
  indexing: boolean;
  stats: { nodes: number; edges: number; files: number };
}
