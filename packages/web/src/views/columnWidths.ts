/**
 * The L5 view's three column widths: user-resizable, persisted across
 * sessions, and expressed as `fr` fractions rather than pixels so the split
 * survives a window resize.
 *
 * Applied through the `--l5-columns` custom property (the same trick as
 * `--sidebar-width`): dragging writes one style property on the grid, so a
 * drag costs no React render.
 *
 * The defaults are near-equal thirds with a nudge to the middle. Source is the
 * reason the page exists and a code line is simply wider than a symbol name —
 * but the old 1:2:1 was not what made the source column collapse. That was
 * `minmax(auto, 1fr)`: a grid column cannot shrink below its content's
 * min-content width, and one 39-character symbol name in an un-shrinkable
 * `.call-name` set a floor the source column then paid for. Hence the
 * `minmax(0, …)` in styles.css — without it these fractions are advisory.
 */

export type ColumnFractions = [number, number, number];

const STORAGE_KEY = 'lsp-viz.l5Columns';

export const DEFAULT_FRACTIONS: ColumnFractions = [1, 1.35, 1];

/** Width of a drag handle, in px — a real grid track between the columns. */
export const COLUMN_DIVIDER_PX = 10;

/** No column may be dragged narrower than this share of the row. */
const MIN_FRACTION = 0.3;

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The persisted split, if the user has ever dragged a divider. */
export function loadFractions(): ColumnFractions | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [a, b, c] = parsed as unknown[];
    if (!isFraction(a) || !isFraction(b) || !isFraction(c)) return null;
    return [a, b, c];
  } catch {
    return null;
  }
}

export function saveFractions(fractions: ColumnFractions): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fractions.map((f) => Number(f.toFixed(4)))));
}

export function clearFractions(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Move one divider by `deltaFr`, taking from one neighbour and giving to the
 * other. The pair's total is preserved, so dragging divider 0 never resizes
 * column 2 — a divider is a boundary, not a scale factor.
 */
export function resizeAt(
  fractions: ColumnFractions,
  index: 0 | 1,
  deltaFr: number,
): ColumnFractions {
  const [a, b, c] = fractions;
  const lo = index === 0 ? a : b;
  const hi = index === 0 ? b : c;
  const pair = lo + hi;
  const left = Math.min(Math.max(lo + deltaFr, MIN_FRACTION), pair - MIN_FRACTION);
  return index === 0 ? [left, pair - left, c] : [a, left, pair - left];
}

/** `fr` per pixel for a given grid width (the dividers are fixed px tracks). */
export function fractionPerPixel(fractions: ColumnFractions, gridWidth: number): number {
  const track = Math.max(1, gridWidth - COLUMN_DIVIDER_PX * 2);
  return (fractions[0] + fractions[1] + fractions[2]) / track;
}

export function applyColumns(el: HTMLElement | null, fractions: ColumnFractions): void {
  el?.style.setProperty(
    '--l5-columns',
    fractions
      .map((f) => `minmax(0, ${f}fr)`)
      .join(` ${COLUMN_DIVIDER_PX}px `),
  );
}
