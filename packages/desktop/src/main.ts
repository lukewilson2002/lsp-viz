/**
 * The Electron entry point: app lifecycle, the `app://` handler, and the IPC
 * endpoint the renderer's transport calls.
 *
 * There is no HTTP server, no port, and no browser here. A window loads
 * `app://bundle/index.html` and reaches the backend through `ipcMain.handle`,
 * which forwards to the worker owned by that window's session and hands the
 * answer straight back. This file holds no API logic on purpose — see
 * `@lsp-viz/server`'s `api.ts` for why.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { ApiParams, ApiRouteName } from '@lsp-viz/core';
import channels from './ipc.cjs';
import type { ApiReply } from './worker-protocol.js';
import { buildMenu, openRepo, promptForRepo } from './menu.js';
import { APP_ORIGIN, registerAppScheme, serveApp } from './protocol.js';
import { RepoSession } from './session.js';
import { forgetRepo, recentRepos } from './state.js';

/**
 * The app is called lsp-viz, not "@lsp-viz/desktop" and not "Electron".
 *
 * Three separate things read a name and only one of them is the window title.
 * `productName` in package.json / electron-builder.yml names the PACKAGED
 * bundle; this call names the RUNNING app, which is what `app.name` — and so
 * the macOS app menu, the About panel and `app.getPath('userData')` — reads.
 * It has to happen before `whenReady`, because the menu and the paths are
 * resolved from it once. (In a dev run the bold menu-bar title still comes
 * from the Electron.app bundle's Info.plist, which no runtime call can move;
 * a packaged build shows lsp-viz there too.)
 */
app.setName('lsp-viz');

// Must happen before the app is ready — a privileged scheme cannot be
// registered once the first window exists.
registerAppScheme();

/**
 * `--repo <path>`, the dev convenience behind `pnpm desktop -- --repo ./x`.
 *
 * A relative path has to resolve against the directory the USER typed it in,
 * which is not `process.cwd()`: `pnpm --filter` runs a package script with the
 * cwd set to that package, so `./fixtures/demo-repo` typed at the repo root
 * would resolve under `packages/desktop/` and land on nothing. Package
 * managers set `INIT_CWD` to the original invocation directory for exactly
 * this reason.
 *
 * A packaged app has no `INIT_CWD` (and is usually launched from Finder with
 * cwd `/`), so it falls back to cwd, which is the right answer when someone
 * runs the binary from a shell.
 */
function repoFromArgv(): string | undefined {
  const at = process.argv.indexOf('--repo');
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value === undefined) return undefined;
  const base = process.env.INIT_CWD ?? process.cwd();
  return path.resolve(base, value);
}

function isRepoDir(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide what to show on launch: an explicit `--repo`, else the most recent
 * repo that still exists, else the picker. Repos that have been moved or
 * deleted are dropped from history rather than reported — a stale entry is not
 * an error worth a dialog.
 */
async function openInitialRepo(): Promise<void> {
  const explicit = repoFromArgv();
  if (explicit !== undefined) {
    if (isRepoDir(explicit)) {
      openRepo(explicit);
      return;
    }
    // Name the resolved path AND what it came from: a relative --repo that
    // resolved somewhere surprising is otherwise very hard to read back.
    const typed = process.argv[process.argv.indexOf('--repo') + 1] ?? '';
    dialog.showErrorBox(
      'lsp-viz',
      `Not a directory: ${explicit}\n\n(--repo ${typed}, resolved against ${
        process.env.INIT_CWD ?? process.cwd()
      })`,
    );
  }

  for (const candidate of recentRepos()) {
    if (isRepoDir(candidate)) {
      openRepo(candidate);
      return;
    }
    forgetRepo(candidate);
  }

  const chosen = await promptForRepo();
  // Nothing open and nothing chosen: there is no app to be, so exit rather
  // than idle in the dock with no windows.
  if (chosen === null && RepoSession.count() === 0) app.quit();
}

app.whenReady().then(async () => {
  serveApp();
  buildMenu();

  ipcMain.handle(
    channels.API,
    async (event, route: ApiRouteName, params: ApiParams): Promise<ApiReply> => {
      const session = RepoSession.forWebContents(event.sender.id);
      if (!session) {
        return { ok: false, status: 500, error: 'no repository is open in this window' };
      }
      return session.call(route, params ?? {});
    },
  );

  ipcMain.handle(channels.OPEN_REPO, async (event): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return (await promptForRepo(window)) !== null;
  });

  await openInitialRepo();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openInitialRepo();
  });
}, (err: unknown) => {
  dialog.showErrorBox('lsp-viz failed to start', String(err));
  app.exit(1);
});

app.on('window-all-closed', () => {
  // macOS convention: the app outlives its windows and waits in the dock.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  RepoSession.shutdownAll();
});

/**
 * Two hard limits on what a renderer may do, belt-and-braces behind the
 * sandbox. The frontend never navigates away from the bundle and never opens
 * a window; if a bug or a crafted repo name ever made it try, a click must not
 * turn this window into a browser pointed at someone else's page.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) event.preventDefault();
  });
});
