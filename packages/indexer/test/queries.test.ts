import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../src/adapters/typescript.js';
import { captureAll, getLanguage, withTree } from '../src/treesitter.js';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

async function capture(relPath: string, query: string): Promise<string[]> {
  const source = readFileSync(path.join(fixtureRoot, relPath), 'utf8');
  const language = await getLanguage(typescriptAdapter.grammarWasmPath(relPath));
  return withTree(language, source, (tree) =>
    captureAll(language, query, tree).map((c) => c.node.text),
  );
}

describe('typescript adapter tree-sitter queries', () => {
  it('captures import specifiers in app/src/commands/report.ts', async () => {
    const specifiers = await capture(
      'packages/app/src/commands/report.ts',
      typescriptAdapter.importQuery,
    );
    expect(specifiers).toEqual(['@demo/math', '@demo/text']);
  });

  it('captures re-export specifiers in math/src/index.ts', async () => {
    const specifiers = await capture('packages/math/src/index.ts', typescriptAdapter.importQuery);
    // export {...} from './arithmetic' / './vector' (x2: value + type) / './stats'
    expect(specifiers).toEqual(['./arithmetic', './vector', './vector', './stats']);
  });

  it('captures exported top-level names in text/src/format.ts', async () => {
    const names = await capture('packages/text/src/format.ts', typescriptAdapter.exportQuery);
    expect(names).toContain('DEFAULT_WIDTH');
    expect(names).toContain('padCell');
    expect(names).toContain('formatRow');
    expect(names).toContain('formatTable');
  });
});
