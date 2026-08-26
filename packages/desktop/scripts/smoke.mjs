/**
 * End-to-end smoke check: boots the REAL main process, waits for the renderer
 * to settle, then reports what the window actually did — console errors,
 * preload failures, renderer crashes — and saves a screenshot.
 *
 *   npx electron scripts/smoke.mjs --repo ../../fixtures/demo-repo
 *
 * Lives outside src/ because it is a harness, not part of the app: it imports
 * dist/main.js unmodified rather than asking the app to behave differently
 * under test.
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[process.argv.indexOf('--out') + 1] ?? 'smoke.png';
const settleMs = Number(process.argv[process.argv.indexOf('--settle') + 1] ?? 12000);

const problems = [];
const logs = [];

await import('../dist/main.js');

app.on('browser-window-created', (_event, win) => {
  const wc = win.webContents;
  wc.on('console-message', (event) => {
    const line = `[${event.level}] ${event.message}`;
    logs.push(line);
    if (event.level === 'error' || event.level === 3) problems.push(`console: ${line}`);
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    problems.push(`preload-error ${preloadPath}: ${error.message}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    problems.push(`render-process-gone: ${JSON.stringify(details)}`);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    problems.push(`did-fail-load ${code} ${desc} ${url}`);
  });

  wc.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, settleMs));

    // Ask the page what it rendered — the real proof the transport worked.
    const probe = await wc
      .executeJavaScript(
        `(() => ({
           desktop: window.lspviz !== undefined,
           title: document.title,
           nodes: document.querySelectorAll('.react-flow__node').length,
           edges: document.querySelectorAll('.react-flow__edge').length,
           crumbs: Array.from(document.querySelectorAll('nav button, header button')).map(b => b.textContent).slice(0, 8),
           status: (document.body.innerText || '').split('\\n').filter(Boolean).slice(-6),
           bodyStart: (document.body.innerText || '').slice(0, 400),
         }))()`,
      )
      .catch((err) => ({ error: String(err) }));

    const image = await wc.capturePage();
    writeFileSync(path.resolve(out), image.toPNG());

    console.log('SMOKE_RESULT ' + JSON.stringify(probe, null, 2));
    console.log('SMOKE_PROBLEMS ' + JSON.stringify(problems, null, 2));
    console.log('SMOKE_CONSOLE ' + JSON.stringify(logs.slice(0, 25), null, 2));
    app.exit(problems.length > 0 ? 1 : 0);
  });
});

setTimeout(() => {
  console.log('SMOKE_TIMEOUT — window never finished loading');
  console.log('SMOKE_PROBLEMS ' + JSON.stringify(problems, null, 2));
  app.exit(3);
}, settleMs + 40000);
