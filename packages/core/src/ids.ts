import { createHash } from 'node:crypto';

const SEP = '\u0000';

function hash16(parts: readonly string[]): string {
  return createHash('sha1').update(parts.join(SEP)).digest('hex').slice(0, 16);
}

/**
 * Deterministic node id: stable across re-index runs as long as the symbol
 * keeps its (path, kind, name, containerName). Line/column moves do NOT change
 * the id by design.
 */
export function nodeId(
  path: string,
  kind: string,
  name: string,
  containerName?: string | null,
): string {
  return hash16(['n', path, kind, name, containerName ?? '']);
}

export function edgeId(kind: string, from: string, to: string): string {
  return hash16(['e', kind, from, to]);
}

export function aggregateEdgeId(parentId: string, kind: string, from: string, to: string): string {
  return hash16(['a', parentId, kind, from, to]);
}

/** Id for a whole-repo database file name etc. */
export function repoHash(absoluteRepoRoot: string): string {
  return hash16(['r', absoluteRepoRoot]);
}
