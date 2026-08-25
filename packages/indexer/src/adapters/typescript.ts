/**
 * TypeScript/JavaScript language adapter — the only place in the indexer with
 * TS-specific knowledge (grammars, queries, module resolution, LSP command,
 * SymbolKind mapping).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { NodeKind } from '@lsp-viz/core';
import type { LanguageAdapter, ResolveContext } from '../types.js';

const require = createRequire(import.meta.url);

const TS_WASM = require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm');
const TSX_WASM = require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm');
const LSP_CLI = require.resolve('typescript-language-server/lib/cli.mjs');

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Verified against @vscode/tree-sitter-wasm's typescript AND tsx grammars:
 * static imports, `export ... from` re-exports (named and star), and dynamic
 * `import('...')` calls each capture their specifier as @source.
 */
const IMPORT_QUERY = `
(import_statement source: (string (string_fragment) @source))
(export_statement source: (string (string_fragment) @source))
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @source)))
`;

/**
 * Exported top-level names as @name: exported declarations (function, class,
 * abstract class, interface, type alias, enum, const/let/var) and
 * `export { a, b as c }` lists (the alias wins when present).
 */
const EXPORT_QUERY = `
(export_statement declaration: (function_declaration name: (identifier) @name))
(export_statement declaration: (generator_function_declaration name: (identifier) @name))
(export_statement declaration: (class_declaration name: (type_identifier) @name))
(export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))
(export_statement declaration: (interface_declaration name: (type_identifier) @name))
(export_statement declaration: (type_alias_declaration name: (type_identifier) @name))
(export_statement declaration: (enum_declaration name: (identifier) @name))
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))
(export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name)))
(export_specifier !alias name: (identifier) @name)
(export_specifier alias: (identifier) @name)
`;

/** NodeNext-style: an emitted-JS specifier suffix and its source equivalents. */
const JS_TO_TS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.js', ['.ts', '.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
  ['.jsx', ['.tsx']],
];

/**
 * All file candidates for a normalized repo-relative base path, in preference
 * order: exact, NodeNext .js→.ts rewrites, +extension, /index+extension.
 */
function candidatePaths(base: string): string[] {
  const out: string[] = [base];
  for (const [jsExt, tsExts] of JS_TO_TS) {
    if (base.endsWith(jsExt)) {
      const stem = base.slice(0, -jsExt.length);
      for (const tsExt of tsExts) out.push(stem + tsExt);
    }
  }
  for (const ext of EXTENSIONS) out.push(base + ext);
  for (const ext of EXTENSIONS) out.push(`${base}/index${ext}`);
  return out;
}

function firstExisting(base: string, ctx: ResolveContext): string | null {
  for (const candidate of candidatePaths(base)) {
    if (ctx.fileExists(candidate)) return candidate;
  }
  return null;
}

function resolveRelative(specifier: string, fromRelPath: string, ctx: ResolveContext): string | null {
  const fromDir = path.posix.dirname(fromRelPath);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (base.startsWith('..')) return null; // escapes the repo
  return firstExisting(base, ctx);
}

function resolveWorkspace(specifier: string, ctx: ResolveContext): string | null {
  for (const pkg of ctx.packages) {
    if (specifier === pkg.name) {
      // Entry paths may point at build output (e.g. dist/index.js) that exists
      // on disk but is ignored by the walk — only trust ones the index can see.
      for (const entry of pkg.entryPaths) {
        const resolved = firstExisting(entry, ctx);
        if (resolved) return resolved;
      }
      const srcIndex = firstExisting(path.posix.join(pkg.dir, 'src/index'), ctx);
      if (srcIndex) return srcIndex;
      return firstExisting(path.posix.join(pkg.dir, 'index'), ctx);
    }
    if (specifier.startsWith(`${pkg.name}/`)) {
      const subpath = specifier.slice(pkg.name.length + 1);
      const base = path.posix.normalize(path.posix.join(pkg.dir, subpath));
      if (base.startsWith('..')) return null;
      return firstExisting(base, ctx);
    }
  }
  return null;
}

/** Common compiled-output directories entry points tend to live in. */
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out', 'output']);

export const typescriptAdapter: LanguageAdapter = {
  id: 'typescript',
  displayName: 'TypeScript',
  extensions: EXTENSIONS,

  grammarWasmPath(relFilePath: string): string {
    const ext = path.posix.extname(relFilePath);
    return ext === '.tsx' || ext === '.jsx' ? TSX_WASM : TS_WASM;
  },

  importQuery: IMPORT_QUERY,
  exportQuery: EXPORT_QUERY,

  resolveImport(specifier: string, fromRelPath: string, ctx: ResolveContext): string | null {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return resolveRelative(specifier, fromRelPath, ctx);
    }
    return resolveWorkspace(specifier, ctx); // null = external package
  },

  resolveEntrySource(entryRelPath, pkg, ctx): string | null {
    // The entry may itself be walkable source (fixture-style main: src/index.ts),
    // or a .js sibling of a .ts source — firstExisting covers both.
    const direct = firstExisting(entryRelPath, ctx);
    if (direct) return direct;
    // Compiled output (dist/cli.js): strip the build dir and look in src/.
    const inPkg =
      pkg.dir === ''
        ? entryRelPath
        : entryRelPath.startsWith(`${pkg.dir}/`)
          ? entryRelPath.slice(pkg.dir.length + 1)
          : null;
    if (inPkg === null) return null;
    const segments = inPkg.split('/');
    const buildDir = segments[0];
    if (segments.length < 2 || buildDir === undefined || !BUILD_DIRS.has(buildDir)) return null;
    const rest = segments.slice(1).join('/');
    return (
      firstExisting(path.posix.join(pkg.dir, 'src', rest), ctx) ??
      firstExisting(path.posix.join(pkg.dir, rest), ctx)
    );
  },

  lspCommand(_repoRoot: string): { command: string; args: readonly string[] } {
    return { command: process.execPath, args: [LSP_CLI, '--stdio'] };
  },

  mapSymbolKind(lspSymbolKind: number): NodeKind | null {
    switch (lspSymbolKind) {
      case 5: // Class
      case 23: // Struct
        return 'class';
      case 6: // Method
      case 9: // Constructor
        return 'method';
      case 10: // Enum
        return 'type';
      case 11: // Interface
        return 'interface';
      case 12: // Function
        return 'function';
      case 13: // Variable
      case 14: // Constant
        return 'variable';
      default:
        // Property (7) / Field (8) and everything else: skip.
        return null;
    }
  },
};
