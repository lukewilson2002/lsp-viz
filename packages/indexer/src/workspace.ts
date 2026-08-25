/**
 * Workspace/package discovery. Parses pnpm-workspace.yaml `packages` globs
 * (simple globs only: `dir/*` and literal paths) or package.json `workspaces`,
 * falling back to treating the repo itself as one package.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkspacePackage } from './types.js';

function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Extremely small pnpm-workspace.yaml reader: extracts the string list under
 * the top-level `packages:` key. Good enough for the common
 * `packages:\n  - packages/*` shape; anything unparsable yields [].
 */
function parsePnpmWorkspacePackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item?.[1]) {
        out.push(item[1].replace(/^['"]|['"]$/g, ''));
        continue;
      }
      // A new top-level key (or any non-list content) ends the block.
      if (line.trim() !== '') inPackages = false;
    }
  }
  return out;
}

interface PackageJson {
  name?: unknown;
  workspaces?: unknown;
  main?: unknown;
  module?: unknown;
  bin?: unknown;
  exports?: unknown;
}

function readPackageJson(absDir: string): PackageJson | null {
  const p = path.join(absDir, 'package.json');
  if (!isFile(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** Collect every string leaf of a main/module/bin/exports-shaped value. */
function collectEntryValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const v of Object.values(value)) collectEntryValues(v, out, depth + 1);
  }
}

/** Resolve entry-point declarations to repo-relative paths of real files. */
function resolveEntryPaths(repoRoot: string, pkgDir: string, pkg: PackageJson): string[] {
  const raw: string[] = [];
  collectEntryValues(pkg.main, raw);
  collectEntryValues(pkg.module, raw);
  collectEntryValues(pkg.bin, raw);
  collectEntryValues(pkg.exports, raw);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (value === '' || value.includes('*')) continue;
    const rel = toPosix(path.posix.normalize(path.posix.join(pkgDir, value)));
    if (rel.startsWith('..') || seen.has(rel)) continue;
    if (!isFile(path.join(repoRoot, rel))) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** Expand one workspace glob/literal into candidate package dirs (repo-relative). */
function expandPattern(repoRoot: string, pattern: string): string[] {
  const cleaned = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned.startsWith('!')) return [];
  if (cleaned.endsWith('/*')) {
    const base = cleaned.slice(0, -2);
    const absBase = path.join(repoRoot, base);
    if (!isDirectory(absBase)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(absBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      out.push(path.posix.join(base, entry.name));
    }
    return out;
  }
  if (cleaned.includes('*')) return []; // unsupported glob shape
  return isDirectory(path.join(repoRoot, cleaned)) ? [cleaned] : [];
}

function workspacePatterns(repoRoot: string): string[] {
  const yamlPath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (isFile(yamlPath)) {
    const patterns = parsePnpmWorkspacePackages(readFileSync(yamlPath, 'utf8'));
    if (patterns.length > 0) return patterns;
  }
  const rootPkg = readPackageJson(repoRoot);
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((w): w is string => typeof w === 'string');
  if (ws !== null && typeof ws === 'object') {
    const pkgs = (ws as { packages?: unknown }).packages;
    if (Array.isArray(pkgs)) return pkgs.filter((w): w is string => typeof w === 'string');
  }
  return [];
}

/**
 * Discover workspace packages. Every matched directory containing a
 * package.json becomes a WorkspacePackage; with no workspace config the repo
 * itself is a single package (dir '').
 */
export function discoverPackages(repoRoot: string): WorkspacePackage[] {
  const patterns = workspacePatterns(repoRoot);
  const out: WorkspacePackage[] = [];
  const seenDirs = new Set<string>();

  for (const pattern of patterns) {
    for (const dir of expandPattern(repoRoot, pattern)) {
      if (seenDirs.has(dir)) continue;
      const pkg = readPackageJson(path.join(repoRoot, dir));
      if (!pkg) continue;
      seenDirs.add(dir);
      out.push({
        name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : path.posix.basename(dir),
        dir,
        entryPaths: resolveEntryPaths(repoRoot, dir, pkg),
      });
    }
  }

  if (out.length > 0) {
    out.sort((a, b) => a.dir.localeCompare(b.dir));
    return out;
  }

  // Fallback: the repo is a single package.
  const rootPkg = readPackageJson(repoRoot);
  const name =
    rootPkg && typeof rootPkg.name === 'string' && rootPkg.name !== ''
      ? rootPkg.name
      : path.basename(path.resolve(repoRoot));
  return [
    {
      name,
      dir: '',
      entryPaths: rootPkg ? resolveEntryPaths(repoRoot, '', rootPkg) : [],
    },
  ];
}
