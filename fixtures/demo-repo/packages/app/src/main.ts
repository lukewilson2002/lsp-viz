import { runCli } from './cli';

export function main(argv: string[]): number {
  try {
    const output = runCli(argv);
    console.log(output);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

main(process.argv.slice(2));
