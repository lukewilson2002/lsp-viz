/**
 * Teardown check: open a repo, then close the window and quit the way a user
 * does, asserting that neither path throws in the main process.
 *
 *   npx electron scripts/close-test.mjs --repo ../../fixtures/demo-repo
 *
 * Guards a specific bug: `closed` fires AFTER the WebContents is destroyed, so
 * any teardown that reads `window.webContents` throws "Object has been
 * destroyed" — as an uncaught exception, which Electron shows as an error
 * dialog and which kills the app on every window close.
 */
import { app, BrowserWindow } from 'electron';

const failures = [];
process.on('uncaughtException', (err) => failures.push(`uncaughtException: ${err.stack}`));
process.on('unhandledRejection', (err) => failures.push(`unhandledRejection: ${String(err)}`));

await import('../dist/main.js');

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 6000));

    console.log('CLOSE_TEST closing window…');
    win.close();
    await new Promise((r) => setTimeout(r, 2500));
    console.log('CLOSE_TEST windows remaining:', BrowserWindow.getAllWindows().length);

    // Report BEFORE quitting: app.quit() tears this script down with the app,
    // so anything logged after it never lands.
    console.log(failures.length === 0 ? 'CLOSE_TEST PASS' : 'CLOSE_TEST FAIL');
    for (const f of failures) console.log(f);

    console.log('CLOSE_TEST quitting…');
    app.quit();
  });
});
