import { mean, variance } from '@demo/math';
import { formatTable, slugify } from '@demo/text';

export function buildReport(values: number[]): string {
  const title = slugify('Values Report');
  const rows: string[][] = [
    ['metric', 'value'],
    ['count', String(values.length)],
    ['mean', mean(values).toFixed(2)],
    ['variance', variance(values).toFixed(2)],
  ];
  return `# ${title}\n${formatTable(rows)}`;
}
