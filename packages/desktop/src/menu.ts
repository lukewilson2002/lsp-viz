/**
 * The application menu. Everything here is something the web UI cannot do for
 * itself — picking a repo off the filesystem, opening a second window, forcing
 * a re-index — plus the standard items a Mac user will hit reflexively.
 *
 * The in-app shortcuts (⌘K search, Backspace to go back) stay where they are,
 * in `packages/web/src/keys.ts`: putting them here would make them Electron-only
 * and silently break the browser host.
 */

import { Menu, app, dialog, shell } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { RepoSession } from './session.js';
import { forgetRepo, recentRepos, rememberRepo } from './state.js';

const isMac = process.platform === 'darwin';

/**
 * Prompt for a repo and open it. Returns the chosen path, or null if the user
 * cancelled — the caller decides whether cancelling means "quit" (nothing else
 * is open) or "never mind".
 */
export async function promptForRepo(parent?: BrowserWindow): Promise<string | null> {
  const result = parent
    ? await dialog.showOpenDialog(parent, {
        title: 'Open Repository',
        properties: ['openDirectory'],
        buttonLabel: 'Open',
      })
    : await dialog.showOpenDialog({
        title: 'Open Repository',
        properties: ['openDirectory'],
        buttonLabel: 'Open',
      });
  const chosen = result.filePaths[0];
  if (result.canceled || chosen === undefined) return null;
  openRepo(chosen);
  return chosen;
}

/** Open a repo in a window (focusing the existing one if it's already open). */
export function openRepo(repoRoot: string): RepoSession {
  rememberRepo(repoRoot);
  const session = RepoSession.open(repoRoot);
  buildMenu();
  return session;
}

function recentSubmenu(): MenuItemConstructorOptions[] {
  const recent = recentRepos();
  if (recent.length === 0) {
    return [{ label: 'No Recent Repositories', enabled: false }];
  }
  return [
    ...recent.map((repoRoot) => ({
      label: repoRoot.replace(app.getPath('home'), '~'),
      click: () => openRepo(repoRoot),
    })),
    { type: 'separator' as const },
    {
      label: 'Clear Menu',
      click: () => {
        for (const repoRoot of recentRepos()) forgetRepo(repoRoot);
        buildMenu();
      },
    },
  ];
}

export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repository…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void promptForRepo();
          },
        },
        { label: 'Open Recent', submenu: recentSubmenu() },
        { type: 'separator' },
        {
          label: 'Re-index',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => RepoSession.focused()?.reindex('diff'),
        },
        {
          label: 'Re-index (Full)',
          accelerator: 'CmdOrCtrl+Alt+Shift+R',
          click: () => RepoSession.focused()?.reindex('full'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'lsp-viz on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
