/**
 * Local copies of tiny @lsp-viz/core VALUE exports. The web bundle may only
 * `import type` from '@lsp-viz/core' (a value import would drag better-sqlite3
 * into the browser bundle), so these are deliberately duplicated here.
 * KEEP IN SYNC with packages/core/src/types.ts.
 */

import type { NodeKind, ViewLevel } from '@lsp-viz/core';

/** The singleton workspace root node id (core's ROOT_NODE_ID). */
export const ROOT_NODE_ID = 'root';

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

/** Leaf symbols get the focused L5 view instead of a canvas. */
export function isLeafSymbolKind(kind: NodeKind): boolean {
  return levelForViewParent(kind) === 5;
}

/** Containers have no file of their own (mirrors core's CONTAINER_KINDS). */
export function isContainerKind(kind: NodeKind): boolean {
  return kind === 'workspace' || kind === 'package' || kind === 'directory';
}

/** Kinds that make sense to drill into from a canvas. */
export function isDrillableKind(kind: NodeKind): boolean {
  // Everything except the workspace root itself can be a view focus; leaf
  // symbols drill into their L5 view.
  return kind !== 'workspace';
}
