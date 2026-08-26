/**
 * `app://` — how the renderer gets the frontend.
 *
 * A desktop app has no origin, and the two obvious alternatives are both
 * wrong: `file://` gives every page a null origin (which breaks module
 * workers, and this app lays out its graph in one), and a localhost HTTP
 * server puts the whole graph behind a port any other process on the machine
 * can read. A privileged custom scheme is a real, secure origin that only this
 * app can serve, and Vite's default absolute asset paths (`/assets/...`)
 * resolve under it unchanged.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { webDist } from './paths.js';

export const APP_SCHEME = 'app';

/** The one URL a window loads. `bundle` is a fixed host, not a real one. */
export const APP_ORIGIN = `${APP_SCHEME}://bundle`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

/**
 * Must run before `app.whenReady()`. `standard` makes it a proper origin (so
 * it can host module workers and be a CSP subject), `secure` puts it in the
 * trustworthy-origin bucket alongside https, and `supportFetchAPI` lets the
 * bundle's own dynamic imports (Shiki's grammar chunks) load.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Wire the handler. Must run after `app.whenReady()`. */
export function serveApp(): void {
  const root = path.resolve(webDist());

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(root, relative);

    // Traversal guard: a request may never escape the bundle directory, even
    // though nothing but our own bundle should ever be asking.
    const inside = target === root || target.startsWith(root + path.sep);
    const isFile = inside && existsSync(target) && statSync(target).isFile();

    // Anything that isn't a real file is a client-side route (the app pushes
    // history entries as you drill in), so it gets index.html — the same
    // single-page fallback the Fastify host serves.
    const file = isFile ? target : path.join(root, 'index.html');
    if (!existsSync(file)) {
      return new Response(`frontend not built — expected ${root}/index.html`, {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const response = await net.fetch(pathToFileURL(file).toString());

    // Electron warns (rightly) about a renderer with no policy. Everything
    // this app displays ships inside the bundle, so the policy is simply
    // "nothing but us": no remote code, no remote data, no frames. Two
    // allowances are load-bearing rather than lazy — `wasm-unsafe-eval` for
    // Shiki's oniguruma regex engine, and inline STYLE for React Flow's
    // transforms and Shiki's per-token colours, both of which are written as
    // style attributes on elements.
    const headers = new Headers(response.headers);
    headers.set(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    return new Response(response.body, { status: response.status, headers });
  });
}
