import { add, square } from './arithmetic';

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((acc, v) => add(acc, v), 0);
  return total / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return mean([sorted[mid - 1] as number, sorted[mid] as number]);
}

export function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => square(v - avg));
  return mean(squaredDiffs);
}
