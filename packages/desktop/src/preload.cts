/**
 * The only thing the renderer can see of Electron.
 *
 * Runs sandboxed with context isolation, so this file has no filesystem, no
 * child processes, and no `require` beyond Electron's own allowlist — it can
 * do nothing but pass structured-clonable messages across three channels. The
 * shape exposed here is mirrored by `LspVizBridge` in
 * `packages/web/src/api/transport.ts`; the frontend feature-detects it, which
 * is why one Vite bundle serves both the desktop app and `lsp-viz <repo>`.
 *
 * Written in `import =` form because the repo sets `verbatimModuleSyntax`,
 * which (correctly) refuses to let ESM syntax be silently rewritten into
 * `require` calls.
 */

import electron = require('electron');
import type { IpcRendererEvent } from 'electron';

/**
 * That same sandbox is why the channel names are spelled out again here
 * instead of imported: the polyfilled `require` resolves `electron` and a
 * couple of built-ins, and nothing on disk — `require('./ipc.cjs')` throws
 * "module not found" and the preload never runs, which the renderer
 * experiences as a silent fallback to the HTTP transport.
 *
 * So they are pinned to `ipc.cts` by TYPE instead. `typeof import(...)` is a
 * type query: erased before emit, zero runtime cost, and because `ipc.cts`
 * declares its channels `as const`, each annotation below is a string LITERAL
 * type. Change a channel name in one file and the other stops compiling.
 */
type Channels = typeof import('./ipc.cjs');

const API: Channels['API'] = 'lspviz:api';
const EVENT: Channels['EVENT'] = 'lspviz:index-event';
const OPEN_REPO: Channels['OPEN_REPO'] = 'lspviz:open-repo';

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('lspviz', {
  invoke: (route: string, params: unknown): Promise<unknown> =>
    ipcRenderer.invoke(API, route, params),

  onIndexEvent: (handle: (message: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: unknown): void => handle(message);
    ipcRenderer.on(EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EVENT, listener);
    };
  },

  openRepo: (): Promise<boolean> => ipcRenderer.invoke(OPEN_REPO) as Promise<boolean>,

  platform: process.platform,
});
