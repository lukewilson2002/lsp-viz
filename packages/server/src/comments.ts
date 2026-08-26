/**
 * Leading-comment detection for source slices. Contains no language-specific
 * analysis: it matches comment MARKERS (a data table) against the raw text
 * above a declaration and never parses code.
 *
 * `/api/source/:id` slices exactly `node.range`, which starts at the
 * declaration keyword — so the JSDoc block a reader needs most is the one
 * thing the slice drops. Scanning upward from the declaration recovers it
 * without asking the indexer (or an adapter) for anything new.
 */

/** Line-comment markers. Deliberately one universal set, not per-language. */
const LINE_MARKERS: readonly string[] = ['//', '#', '--'];
/** Block-comment delimiter pairs. */
const BLOCK_PAIRS: readonly (readonly [string, string])[] = [
  ['/*', '*/'],
  ['<!--', '-->'],
];

export interface DocScanOptions {
  /** Never scan at or above this 0-based line (previous sibling's end + 1). */
  floorLine: number;
  /** Maximum comment lines to keep (the ones NEAREST the declaration). */
  maxDocLines: number;
  /** Maximum lines to examine before giving up. */
  maxScan: number;
}

/**
 * A marker counts as a comment only when followed by whitespace, end-of-line,
 * a repeat of its own last character ('///', '##', '---'), or '!' ('#!', '//!').
 * That is what stops a TypeScript private field (`#count = 0`) or a decrement
 * (`--i;`) being mistaken for a comment.
 */
function isLineComment(trimmed: string): boolean {
  for (const marker of LINE_MARKERS) {
    if (!trimmed.startsWith(marker)) continue;
    const sep = trimmed.slice(marker.length, marker.length + 1);
    if (sep === '' || /\s/.test(sep) || sep === '!' || sep === marker[marker.length - 1]) {
      return true;
    }
  }
  return false;
}

/**
 * Scan upward from `declLine` (0-based) for a contiguous leading comment
 * block. Returns the 0-based line the slice should start at; equals
 * `declLine` when there is no doc block.
 *
 * Documented heuristics: the marker table misses `;` (Lisp), `(* *)` (OCaml)
 * and `=begin` (Ruby) — deliberately, because `;` and `!` are common leading
 * characters in mainstream code and false positives are worse than a missing
 * doc comment. The blank-line stop rule is a convention (JSDoc/godoc/rustdoc),
 * not a grammar. Python/Ruby docstrings sit *inside* the declaration so
 * `node.range` already contains them — no `"""` handling wanted.
 */
export function scanLeadingComments(
  lines: readonly string[],
  declLine: number,
  opts: DocScanOptions,
): number {
  let start = declLine;
  let i = declLine - 1;
  let scanned = 0;

  outer: while (i >= opts.floorLine && scanned < opts.maxScan) {
    scanned++;
    const trimmed = (lines[i] ?? '').trim();

    if (trimmed === '') break; // blank line ends the block
    if (isLineComment(trimmed)) {
      start = i;
      i--;
      continue;
    }

    // Block comment: the line must END with a close delimiter, and the line
    // holding the matching OPEN must have only whitespace before it —
    // otherwise it is trailing code like `const x = 1; /* note */`.
    for (const [open, close] of BLOCK_PAIRS) {
      if (!trimmed.endsWith(close)) continue;
      for (let j = i; j >= opts.floorLine && scanned < opts.maxScan; j--, scanned++) {
        const line = lines[j] ?? '';
        const idx = line.indexOf(open);
        if (idx < 0) continue;
        if (line.slice(0, idx).trim() !== '') break outer; // trailing code, not a doc
        start = j;
        i = j - 1;
        continue outer;
      }
      break outer; // unterminated upward — give up
    }

    break; // real code — stop
  }

  return declLine - start > opts.maxDocLines ? declLine - opts.maxDocLines : start;
}
