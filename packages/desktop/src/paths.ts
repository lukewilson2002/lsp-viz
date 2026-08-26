/**
 * Where the built frontend and the worker script live, which differs between
 * `pnpm --filter @lsp-viz/desktop start` (files sit in the workspace) and a
 * packaged app (the frontend is copied to `resources/web`, and everything else
 * is inside the asar).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

/** Directory holding the compiled main-process output (`dist/`). */
export const distDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The built frontend. Packaged builds get it from `extraResources`, which
 * keeps it OUT of the asar — the renderer loads these over `app://` and asar
 * paths are virtual, so a real directory is the simpler contract.
 */
export function webDist(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(distDir, '../../web/dist');
}

/** The utility-process entry point. */
export function workerScript(): string {
  return path.join(distDir, 'worker.js');
}

/** The sandboxed preload script. */
export function preloadScript(): string {
  return path.join(distDir, 'preload.cjs');
}
