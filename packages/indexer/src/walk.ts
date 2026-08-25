/**
 * Source-file enumeration: recursive walk from the repo root that always skips
 * `.git` and `node_modules`, respects `.gitignore` files (root and nested) via
 * the `ignore` package, filters by extension, and skips files over 2 MB.
 * Returns repo-relative paths with posix separators, sorted.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

type Ignore = ReturnType<typeof ignore>;

interface IgnoreScope {
  /** Repo-relative posix dir the .gitignore lives in ('' for root). */
  base: string;
  matcher: Ignore;
}

function loadGitignore(absDir: string, relDir: string): IgnoreScope | null {
  const gitignorePath = path.join(absDir, '.gitignore');
  try {
    const content = readFileSync(gitignorePath, 'utf8');
    return { base: relDir, matcher: ignore().add(content) };
  } catch {
    return null;
  }
}

function isIgnored(scopes: readonly IgnoreScope[], relPath: string, isDir: boolean): boolean {
  for (const scope of scopes) {
    const relative = scope.base === '' ? relPath : relPath.slice(scope.base.length + 1);
    if (relative === '') continue;
    if (scope.matcher.ignores(isDir ? `${relative}/` : relative)) return true;
  }
  return false;
}

/**
 * Enumerate source files under `repoRoot` whose extension is in `extensions`
 * (leading dots, e.g. '.ts').
 */
export function walkFiles(repoRoot: string, extensions: readonly string[]): string[] {
  const extSet = new Set(extensions);
  const out: string[] = [];

  const walk = (absDir: string, relDir: string, scopes: readonly IgnoreScope[]): void => {
    const local = loadGitignore(absDir, relDir);
    const active = local ? [...scopes, local] : scopes;

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (isIgnored(active, rel, true)) continue;
        walk(abs, rel, active);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!extSet.has(path.posix.extname(rel))) continue;
        if (isIgnored(active, rel, false)) continue;
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
        out.push(rel);
      }
    }
  };

  walk(repoRoot, '', []);
  out.sort();
  return out;
}
