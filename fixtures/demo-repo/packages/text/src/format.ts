export const DEFAULT_WIDTH = 12;

export function padCell(value: string, width: number = DEFAULT_WIDTH): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

export function formatRow(cells: string[], width?: number): string {
  return cells.map((cell) => padCell(cell, width)).join(' | ');
}

export function formatTable(rows: string[][], width?: number): string {
  return rows.map((row) => formatRow(row, width)).join('\n');
}
