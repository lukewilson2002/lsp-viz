import { Vector2, mean, median } from '@demo/math';
import { formatRow, truncate } from '@demo/text';

export function summarize(values: number[]): string {
  const centroid = toCentroid(values);
  const lines = [
    formatRow(['mean', mean(values).toFixed(2)]),
    formatRow(['median', median(values).toFixed(2)]),
    formatRow(['centroid', truncate(centroid.length().toFixed(4), 8)]),
  ];
  return lines.join('\n');
}

function toCentroid(values: number[]): Vector2 {
  const points = values.map((v, i) => new Vector2(i, v));
  const sum = points.reduce((acc, p) => acc.plus(p), new Vector2(0, 0));
  return sum.scale(points.length === 0 ? 0 : 1 / points.length);
}
