/**
 * The single source of truth for WHICH rows a node card renders.
 *
 * Card geometry is computed twice: once by `canvas/types.ts` (so ELK — and
 * React Flow, which takes the ELK size verbatim — knows how tall a card is
 * before it exists in the DOM) and once by the browser when NodeCard renders.
 * The two must agree exactly, because `.node-card` is `overflow: hidden` at a
 * height it does not control: under-reserve and a row is clipped. Deriving
 * both from this module makes "rendered but not measured" unrepresentable.
 *
 * Nothing here truncates text for display — CSS ellipsis/clamp does that. The
 * only shortening is path segment trimming, which changes the STRING and must
 * therefore be shared with the width estimate.
 */

import type { GraphNode, NodeKind } from '@lsp-viz/core';

export type CardVariant = 'container' | 'file' | 'symbol';

/** Every row a card can show; `null` fields are rows that don't exist. */
export interface CardRows {
  variant: CardVariant;
  /** node.name, verbatim — never truncated by this module. */
  name: string;
  /** attrs.entry === true → the pill renders in the head row. */
  entry: boolean;
  /** Symbols only; null otherwise. */
  signature: string | null;
  /** Already formatted/trimmed for display (see formatCardPath). */
  path: string | null;
  /**
   * Metrics the other rows don't already carry; null drops the row.
   *
   * Symbol cards have none: the kind is the glyph and the signature, and the
   * line count is the span already printed on the path row. Saying
   * `function · 13 loc` under `ƒ foo` / `foo.ts:5-17` is three restatements
   * of two facts.
   */
  facts: string | null;
  /** Files with attrs.exportedNames.length > 0; null otherwise. */
  exports: string | null;
}

/** Which custom node component renders a graph node of this kind. */
export function cardVariantForKind(kind: NodeKind): CardVariant {
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

const PATH_MAX_SEGMENTS = 3;

/**
 * Truncate from the LEFT, by whole segments. The tail of a path is what
 * identifies it; a middle ellipsis destroys the near-root segment that
 * distinguishes packages/web from packages/core and is harder to scan.
 */
function trimSegments(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= PATH_MAX_SEGMENTS
    ? parts.join('/')
    : `…/${parts.slice(-PATH_MAX_SEGMENTS).join('/')}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Display path for a card; null drops the row entirely. */
export function formatCardPath(node: GraphNode): string | null {
  switch (cardVariantForKind(node.kind)) {
    case 'container':
      // '' only for the root workspace node.
      return node.path === '' ? null : trimSegments(node.path);
    case 'file': {
      const dir = dirname(node.path);
      // The basename is already the card's name — repeating it wastes the row.
      return dir === '' ? './' : trimSegments(dir);
    }
    case 'symbol': {
      // `file.ts:5-17` — the editor/ripgrep convention for a line RANGE, and
      // the reason the card needs no separate `13 loc` row: the span is the
      // line count, stated where you'd look up the location anyway.
      const start = (node.range?.start.line ?? 0) + 1;
      const end = (node.range?.end.line ?? node.range?.start.line ?? 0) + 1;
      return `${basename(node.path)}:${start}${end > start ? `-${end}` : ''}`;
    }
  }
}

export function cardRows(node: GraphNode): CardRows {
  const variant = cardVariantForKind(node.kind);
  const attrs = node.attrs;
  const signature = node.signature !== undefined && node.signature !== '' ? node.signature : null;

  // Symbols get no facts row at all (see CardRows.facts).
  const parts: string[] = variant === 'symbol' ? [] : [node.kind];
  if (variant === 'container') {
    // attrs.symbolCount is a DESCENDANT NODE count (dirs + files + symbols),
    // not a symbol count — say "items", not "symbols".
    if (attrs?.symbolCount !== undefined) parts.push(`${attrs.symbolCount} items`);
  } else if (variant === 'file') {
    if (attrs?.loc !== undefined) parts.push(`${attrs.loc} loc`);
    if (attrs?.exportCount !== undefined) {
      parts.push(`${attrs.exportCount} export${attrs.exportCount === 1 ? '' : 's'}`);
    }
  }

  let exports: string | null = null;
  if (variant === 'file') {
    const names = attrs?.exportedNames ?? [];
    if (names.length > 0) {
      const count = attrs?.exportCount ?? names.length;
      exports = names.slice(0, 3).join(', ') + (count > 3 ? `, +${count - 3}` : '');
    }
  }

  return {
    variant,
    name: node.name,
    // `entry point` is NOT repeated in facts — the pill already carries it.
    entry: attrs?.entry === true,
    signature: variant === 'symbol' ? signature : null,
    path: formatCardPath(node),
    facts: parts.length > 0 ? parts.join(' · ') : null,
    exports,
  };
}
