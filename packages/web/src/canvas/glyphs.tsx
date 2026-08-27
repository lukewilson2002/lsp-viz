import type { NodeKind } from '@lsp-viz/core';
import type { ReactNode } from 'react';

/**
 * Directories get a drawn folder rather than a character. No monospace face in
 * `--font-mono` ships a monochrome folder — U+1F5C0/U+1F5C1 render as tofu and
 * U+1F4C1 resolves to a colour emoji, which would ignore the `.kind-glyph--*`
 * tint and put saturated colour in a palette that reserves it for selection and
 * hover. The character it replaces (U+25B8) was also what TreePane drew for a
 * collapsed row at the time, so a folder in the tree read as "▸ ▸ src". (That
 * row now draws {@link DisclosureChevron}, but the collision would come
 * straight back with any triangle-shaped folder.)
 *
 * `currentColor` keeps it tinted by the same CSS rule as every other glyph, in
 * both colour schemes, and `em` sizing keeps it locked to the glyph font-size.
 */
function FolderGlyph(): ReactNode {
  return (
    <svg className="kind-glyph-svg" viewBox="0 0 16 16" focusable="false" role="presentation">
      <path
        fill="currentColor"
        d="M1.7 12.5V4.1c0-.5.4-.9.9-.9h3.3c.29 0 .56.14.73.38l.83 1.17h6.34c.5 0 .9.4.9.9v6.85c0 .5-.4.9-.9.9H2.6c-.5 0-.9-.4-.9-.9Z"
      />
    </svg>
  );
}

/**
 * The disclosure control on an expandable row (file tree, detail sections).
 *
 * Drawn for the same reason the folder is: the characters it replaces —
 * U+25B8/U+25BE — are Unicode's SMALL triangles, and a small triangle occupies
 * a fraction of its em box by design. Raising the font-size scales the box far
 * faster than the mark inside it, so a legible triangle needs a font-size that
 * blows out the row. A path fills the box it is given.
 *
 * One shape for both states: `.tree-chevron--open` rotates it, which also gives
 * the expand/collapse an animation for free.
 */
export function DisclosureChevron(): ReactNode {
  return (
    <svg className="chevron-svg" viewBox="0 0 16 16" focusable="false" role="presentation">
      <path
        d="M6 3.5 11 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Monochrome glyph per node kind (tinted via CSS classes). */
export function kindGlyph(kind: NodeKind): ReactNode {
  switch (kind) {
    case 'workspace':
      return '◆';
    case 'package':
      return '▣';
    case 'directory':
      return <FolderGlyph />;
    case 'file':
      return '☰';
    case 'function':
      return 'ƒ';
    case 'method':
      return 'ƒ';
    case 'class':
      return '◇';
    case 'interface':
      return '◈';
    case 'type':
      return 'τ';
    case 'variable':
      return '≔';
  }
}
