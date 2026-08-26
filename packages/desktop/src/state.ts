/**
 * The handful of things the app remembers between launches: which repos you
 * have opened, most recent first. Stored as JSON in `userData` — small enough
 * that a database would be silly, and losing it costs one trip through the
 * open dialog.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MAX_RECENT = 10;

interface PersistedState {
  recent: string[];
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'state.json');
}

function read(): PersistedState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedState>;
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { recent };
  } catch {
    // Missing or corrupt: an empty history is a fine answer either way.
    return { recent: [] };
  }
}

function write(state: PersistedState): void {
  try {
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`[lsp-viz] could not persist state: ${String(err)}`);
  }
}

/** Repos opened before, most recent first. */
export function recentRepos(): string[] {
  return read().recent;
}

/** Record a repo as the most recently opened one. */
export function rememberRepo(repoRoot: string): void {
  const state = read();
  const recent = [repoRoot, ...state.recent.filter((entry) => entry !== repoRoot)];
  write({ recent: recent.slice(0, MAX_RECENT) });
}

/** Drop a repo from history — used when it no longer exists on disk. */
export function forgetRepo(repoRoot: string): void {
  const state = read();
  write({ recent: state.recent.filter((entry) => entry !== repoRoot) });
}
