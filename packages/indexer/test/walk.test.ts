import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walkFiles } from '../src/walk.js';

describe('walkFiles', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lsp-viz-walk-'));
    const write = (rel: string, content: string): void => {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };

    write('.gitignore', 'dist\nignored.ts\n*.generated.ts\n');
    write('a.ts', 'export const a = 1;\n');
    write('b.js', 'exports.b = 2;\n');
    write('notes.md', '# not source\n');
    write('ignored.ts', 'export const gone = 0;\n');
    write('api.generated.ts', 'export const gen = 0;\n');
    write('dist/build.ts', 'export const built = 0;\n');
    write('sub/.gitignore', 'secret.ts\n');
    write('sub/keep.ts', 'export const keep = 1;\n');
    write('sub/secret.ts', 'export const secret = 1;\n');
    write('node_modules/dep/index.ts', 'export const dep = 1;\n');
    write('.git/hooks/x.ts', 'export const hook = 1;\n');
    write('huge.ts', `// ${'x'.repeat(2 * 1024 * 1024 + 16)}\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('respects .gitignore (root and nested) and always skips .git/node_modules', () => {
    const files = walkFiles(dir, ['.ts', '.js']);
    expect(files).toEqual(['a.ts', 'b.js', 'sub/keep.ts']);
  });

  it('filters by adapter extensions', () => {
    const onlyTs = walkFiles(dir, ['.ts']);
    expect(onlyTs).toEqual(['a.ts', 'sub/keep.ts']);
    expect(walkFiles(dir, ['.md'])).toEqual(['notes.md']);
  });
});
