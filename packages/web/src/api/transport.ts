/**
 * How the frontend reaches the API. Two hosts serve this app and they do not
 * agree on a wire:
 *
 *  - `lsp-viz <repo>` (the CLI) serves it over HTTP from Fastify, with index
 *    progress on a WebSocket.
 *  - the desktop app loads it from `app://` and answers over Electron IPC —
 *    there is no socket, no port, and no origin to talk to.
 *
 * So every call goes through a {@link Transport}, chosen once at startup. The
 * functions in `client.ts` keep their signatures either way, which is why no
 * component, hook, or store knows which host it is running in.
 *
 * Selection is by feature detection, not by build flag: the preload script
 * defines `window.lspviz`, so a desktop build and a browser build are the same
 * bundle. `vite build` output drops straight into the Electron app.
 */

import type { ApiParams, ApiRouteName, WsServerMessage } from '@lsp-viz/core';
import { connectWs } from '../ws';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Transport {
  /** Call one API route. Rejects with an {@link ApiError} on any failure. */
  invoke<T>(route: ApiRouteName, params?: ApiParams): Promise<T>;
  /** Subscribe to index progress; returns a dispose function. */
  subscribe(handle: (message: WsServerMessage) => void): () => void;
}

/**
 * The IPC bridge the desktop preload exposes on `window`. Mirrored in
 * `packages/desktop/src/preload.ts` — the two must stay in step.
 */
export interface LspVizBridge {
  invoke(route: ApiRouteName, params: ApiParams): Promise<unknown>;
  onIndexEvent(handle: (message: WsServerMessage) => void): () => void;
  openRepo(): Promise<boolean>;
  platform: string;
}

declare global {
  interface Window {
    lspviz?: LspVizBridge;
  }
}

/** Route -> URL, for the HTTP host. The one place paths are spelled out. */
function httpUrl(route: ApiRouteName, params: ApiParams): string {
  const id = encodeURIComponent(params.id ?? '');
  switch (route) {
    case 'graph':
      return `/api/graph?parent=${encodeURIComponent(params.parent ?? '')}`;
    case 'nodeDetail':
      return `/api/node/${id}`;
    case 'source':
      return `/api/source/${id}`;
    case 'links':
      return `/api/links/${id}`;
    case 'search':
      return `/api/search?q=${encodeURIComponent(params.q ?? '')}`;
    case 'symbols':
      return `/api/symbols/${id}`;
    case 'tree':
      return '/api/tree';
    case 'meta':
      return '/api/meta';
    case 'startIndex':
      return '/api/index';
  }
}

/** Fastify over fetch + WebSocket. The browser/CLI host. */
export const httpTransport: Transport = {
  async invoke<T>(route: ApiRouteName, params: ApiParams = {}): Promise<T> {
    const init: RequestInit | undefined =
      route === 'startIndex'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ full: params.full === true }),
          }
        : undefined;
    const res = await fetch(httpUrl(route, params), init);
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // non-JSON error body — keep the status message
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  },
  subscribe: connectWs,
};

/**
 * Electron IPC. Errors arrive as `{ status, error }` rather than as rejected
 * promises so the status survives the structured-clone boundary intact — an
 * Error thrown in the main process reaches the renderer as a string with
 * "Error invoking remote method" glued to the front.
 */
function ipcTransport(bridge: LspVizBridge): Transport {
  return {
    async invoke<T>(route: ApiRouteName, params: ApiParams = {}): Promise<T> {
      const reply = (await bridge.invoke(route, params)) as
        | { ok: true; value: T }
        | { ok: false; status: number; error: string };
      if (!reply.ok) throw new ApiError(reply.status, reply.error);
      return reply.value;
    },
    subscribe: (handle) => bridge.onIndexEvent(handle),
  };
}

/** Whether this bundle is running inside the Electron shell. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.lspviz !== undefined;
}

/**
 * The host OS when running on the desktop, else null. The app needs this for
 * exactly one thing — see the `data-desktop` rules in styles.css — and asks
 * the bridge rather than sniffing the user agent, which under Electron
 * describes Chrome.
 */
export function desktopPlatform(): string | null {
  return typeof window !== 'undefined' ? (window.lspviz?.platform ?? null) : null;
}

const active: Transport = isDesktop() && window.lspviz ? ipcTransport(window.lspviz) : httpTransport;

/** The transport this host runs on, resolved once at module load. */
export function transport(): Transport {
  return active;
}
