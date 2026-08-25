/**
 * Language-agnostic graph IR. Nothing in this file may be TypeScript-the-language
 * specific; new languages plug in by emitting these same shapes.
 */

export type NodeKind =
  | 'workspace'
  | 'package'
  | 'directory'
  | 'file'
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable';

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'references'
  | 'extends'
  | 'implements';

/** 0-based, LSP convention. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** Optional per-node metadata. Everything here must stay language-agnostic. */
export interface NodeAttrs {
  /** Package/file is an entry point (main, exports, bin). */
  entry?: boolean;
  /** Number of exported symbols (file nodes, from the structural layer). */
  exportCount?: number;
  /** Top exported names, for file-node summaries (capped, in export order). */
  exportedNames?: string[];
  /** Line count (file and symbol nodes). */
  loc?: number;
  /** Descendant symbol/file count (container nodes; materialized after indexing). */
  symbolCount?: number;
}

export interface GraphNode {
  /** Stable hash of (path, kind, name, containerName) — deterministic across re-index runs. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Path relative to repo root ('' for the workspace root node). */
  path: string;
  /** Containment parent; null only for the root workspace node. */
  parentId: string | null;
  /** Full extent of the symbol (symbol nodes only). */
  range?: Range;
  /** Identifier range, used for LSP positioning (symbol nodes only). */
  selectionRange?: Range;
  /** Human-readable, from LSP hover/detail — a string, never parsed. */
  signature?: string;
  detail?: string;
  language: string;
  attrs?: NodeAttrs;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  /** Node id. */
  from: string;
  /** Node id. */
  to: string;
  /** Aggregated weight; 1 for plain fine-grained edges. */
  count: number;
  /** Repo-relative path of the file whose analysis produced this edge (fine edges only). */
  sourcePath?: string;
}

/** The singleton workspace root node id. */
export const ROOT_NODE_ID = 'root';

export type ViewLevel = 1 | 2 | 3 | 4 | 5;

export const CONTAINER_KINDS: readonly NodeKind[] = ['workspace', 'package', 'directory'];
export const SYMBOL_KINDS: readonly NodeKind[] = [
  'function',
  'class',
  'method',
  'interface',
  'type',
  'variable',
];

export function isContainerKind(kind: NodeKind): boolean {
  return CONTAINER_KINDS.includes(kind);
}

export function isSymbolKind(kind: NodeKind): boolean {
  return SYMBOL_KINDS.includes(kind);
}

/**
 * The abstraction level of the view shown when a node of `kind` is the focus
 * (i.e. the view rendering its children). Class/interface drill-downs stay at
 * L4 (declarations + call edges); leaf symbols get the L5 focused view.
 */
export function levelForViewParent(kind: NodeKind): ViewLevel {
  switch (kind) {
    case 'workspace':
      return 1;
    case 'package':
      return 2;
    case 'directory':
      return 3;
    case 'file':
    case 'class':
    case 'interface':
      return 4;
    default:
      return 5;
  }
}
