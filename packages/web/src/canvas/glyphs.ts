import type { NodeKind } from '@lsp-viz/core';

/** Monochrome text glyph per node kind (tinted via CSS classes). */
export function kindGlyph(kind: NodeKind): string {
  switch (kind) {
    case 'workspace':
      return '◆';
    case 'package':
      return '▣';
    case 'directory':
      return '▸';
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
