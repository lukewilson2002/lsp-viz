import type { NodeKind } from '@lsp-viz/core';
import type { ReactNode } from 'react';

/**
 * Directories get a drawn folder rather than a character. No monospace face in
 * `--font-mono` ships a monochrome folder — U+1F5C0/U+1F5C1 render as tofu and
 * U+1F4C1 resolves to a colour emoji, which would ignore the `.kind-glyph--*`
 * tint and put saturated colour in a palette that reserves it for selection and
 * hover. The character it replaces (U+25B8) was also the exact glyph TreePane
 * uses for a collapsed row, so a folder in the tree read as "▸ ▸ src".
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
