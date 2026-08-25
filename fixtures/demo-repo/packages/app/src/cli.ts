import { buildReport } from './commands/report';
import { summarize } from './commands/stats';

export interface CliOptions {
  command: string;
  values: number[];
}

export function parseArgs(argv: string[]): CliOptions {
  const [command = 'report', ...rest] = argv;
  const values = rest.map(Number).filter((n) => !Number.isNaN(n));
  return { command, values };
}

export function runCli(argv: string[]): string {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'report':
      return buildReport(options.values);
    case 'stats':
      return summarize(options.values);
    default:
      throw new Error(`unknown command: ${options.command}`);
  }
}
