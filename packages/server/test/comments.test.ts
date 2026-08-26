import { describe, expect, it } from 'vitest';
import { scanLeadingComments } from '../src/comments.js';
import type { DocScanOptions } from '../src/comments.js';

const DEFAULTS: DocScanOptions = { floorLine: 0, maxDocLines: 40, maxScan: 200 };

/** `src` is the whole slice; `declLine` is 0-based, as in GraphNode.range. */
function scan(src: string, declLine: number, opts: Partial<DocScanOptions> = {}): number {
  return scanLeadingComments(src.split('\n'), declLine, { ...DEFAULTS, ...opts });
}

describe('scanLeadingComments', () => {
  it('returns the declaration line when nothing precedes it', () => {
    expect(scan('export function f() {}', 0)).toBe(0);
    expect(scan('import x from "y";\n\nexport function f() {}', 2)).toBe(2);
  });

  it('absorbs a JSDoc block above the declaration', () => {
    expect(scan('/**\n * what f does\n */\nexport function f() {}', 3)).toBe(0);
  });

  it('absorbs a run of line comments, in any of the marker flavours', () => {
    expect(scan('// one\n// two\nfunction f() {}', 2)).toBe(0);
    expect(scan('/// doc\nfunction f() {}', 1)).toBe(0);
    expect(scan('# doc\nfunction f() {}', 1)).toBe(0);
    expect(scan('#!/usr/bin/env node\nfunction f() {}', 1)).toBe(0);
  });

  it('stops at a blank line — the nearest block only', () => {
    expect(scan('// unrelated\n\n// the doc\nfunction f() {}', 3)).toBe(2);
  });

  it('stops at real code', () => {
    expect(scan('const x = 1;\nfunction f() {}', 1)).toBe(1);
  });

  it('does not mistake code that starts with a marker for a comment', () => {
    // A TypeScript private field, not a `#` comment.
    expect(scan('class C {\n  #count = 0;\n  m() {}\n}', 2)).toBe(2);
    // A decrement, not a `--` comment.
    expect(scan('let i = 0;\n--i;\nfunction f() {}', 2)).toBe(2);
  });

  it('rejects a block comment that trails code on the same line', () => {
    expect(scan('const x = 1; /* note */\nfunction f() {}', 1)).toBe(1);
  });

  it('never scans past the floor (the previous sibling declaration)', () => {
    // Line 0 belongs to the sibling above; floorLine keeps it out of the slice.
    expect(scan('// tail of the previous symbol\nfunction f() {}', 1, { floorLine: 1 })).toBe(1);
  });

  it('keeps at most maxDocLines comment lines, nearest the declaration', () => {
    const src = `${Array.from({ length: 60 }, (_, i) => `// c${i}`).join('\n')}\nfunction f() {}`;
    expect(scan(src, 60, { maxDocLines: 20 })).toBe(40);
  });

  it('gives up on an unterminated block comment rather than running away', () => {
    expect(scan('/* opened, never closed\nfunction f() {}', 1)).toBe(1);
  });
});
