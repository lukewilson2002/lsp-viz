/**
 * One open repo = one window + one worker process, paired for life.
 *
 * The pairing is what makes multiple repos work without any of the routing a
 * server would need: a call arrives tagged with the WebContents that made it,
 * that maps to exactly one session, and that session's worker holds exactly
 * one store. Nothing is shared, so nothing has to be keyed by repo.
 */

import path from 'node:path';
import { BrowserWindow, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import type { ApiParams, ApiRouteName } from '@lsp-viz/core';
import type { IndexMode } from '@lsp-viz/indexer';
import channels from './ipc.cjs';
import { APP_INDEX } from './protocol.js';
import { preloadScript, workerScript } from './paths.js';
import type { ApiReply, WorkerMessage, WorkerRequest } from './worker-protocol.js';

const sessions = new Map<number, RepoSession>();

export class RepoSession {
  readonly window: BrowserWindow;
  readonly repoRoot: string;
  /**
   * The window's WebContents id, captured at construction and never re-read.
   *
   * By the time `closed` fires the WebContents is already destroyed, and
   * touching `window.webContents` then throws "Object has been destroyed" —
   * out of an event handler, which means an uncaught exception dialog and a
   * dead app every time someone closes a window. This is also the key every
   * session lookup uses, so it has to outlive the window it identifies.
   */
  readonly contentsId: number;

  private readonly worker: UtilityProcess;
  private readonly pending = new Map<number, (reply: ApiReply) => void>();
  private nextId = 1;
  private dead = false;

  private constructor(repoRoot: string) {
    this.repoRoot = repoRoot;

    this.window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: path.basename(repoRoot),
      backgroundColor: '#11131a',
      // The canvas is the app; a chromeless top strip on macOS gives it the
      // whole window without the frontend needing to know it's in Electron.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      show: false,
      webPreferences: {
        preload: preloadScript(),
        // The renderer runs untrusted-by-default: no Node, no direct Electron,
        // an isolated context, and the sandbox on. Everything it can do is the
        // three channels the preload exposes.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.contentsId = this.window.webContents.id;

    this.worker = utilityProcess.fork(workerScript(), ['--repo', repoRoot], {
      stdio: 'inherit',
      serviceName: `lsp-viz-indexer:${path.basename(repoRoot)}`,
    });

    this.worker.on('message', (message: WorkerMessage) => this.onWorkerMessage(message));
    this.worker.on('exit', (code) => this.onWorkerExit(code));

    this.window.once('ready-to-show', () => this.window.show());
    this.window.on('closed', () => this.dispose());

    void this.window.loadURL(APP_INDEX);
  }

  static open(repoRoot: string): RepoSession {
    const resolved = path.resolve(repoRoot);
    const existing = [...sessions.values()].find((s) => s.repoRoot === resolved);
    if (existing) {
      existing.window.focus();
      return existing;
    }
    const session = new RepoSession(resolved);
    sessions.set(session.contentsId, session);
    return session;
  }

  /** The session that owns a given WebContents, if any. */
  static forWebContents(id: number): RepoSession | undefined {
    return sessions.get(id);
  }

  /** The session whose window is focused — what the menu acts on. */
  static focused(): RepoSession | undefined {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return undefined;
    return sessions.get(window.webContents.id);
  }

  static count(): number {
    return sessions.size;
  }

  /** Ask every worker to close its store, then let the app exit. */
  static shutdownAll(): void {
    for (const session of sessions.values()) session.shutdown();
  }

  /** Run one API call in the worker. Never rejects — failures are replies. */
  call(route: ApiRouteName, params: ApiParams): Promise<ApiReply> {
    if (this.dead) {
      return Promise.resolve({
        ok: false,
        status: 500,
        error: 'the indexer process is not running',
      });
    }
    const id = this.nextId++;
    return new Promise<ApiReply>((resolve) => {
      this.pending.set(id, resolve);
      const request: WorkerRequest = { type: 'call', id, route, params };
      this.worker.postMessage(request);
    });
  }

  /** Start an index run (the menu's Re-index). */
  reindex(mode: IndexMode): void {
    if (this.dead) return;
    const request: WorkerRequest = { type: 'index', mode };
    this.worker.postMessage(request);
  }

  private shutdown(): void {
    if (this.dead) return;
    const request: WorkerRequest = { type: 'shutdown' };
    this.worker.postMessage(request);
  }

  private onWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'ready':
        console.log(`[lsp-viz] worker ready — repo ${message.repoRoot} — db ${message.dbPath}`);
        return;
      case 'reply': {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message.reply);
        return;
      }
      case 'event':
        if (!this.window.isDestroyed()) {
          this.window.webContents.send(channels.EVENT, message.message);
        }
        return;
      case 'fatal':
        console.error(`[lsp-viz] worker failed to start: ${message.message}`);
        this.fail(message.message);
        return;
    }
  }

  private onWorkerExit(code: number): void {
    if (this.dead) return;
    // A clean exit during window teardown is expected; anything else means the
    // backend died under us and every in-flight call is never coming back.
    this.fail(`the indexer process exited (code ${code})`);
  }

  /**
   * Settle everything outstanding and tell the window. The alternative —
   * leaving promises pending — is a UI stuck on spinners with no explanation.
   */
  private fail(message: string): void {
    this.dead = true;
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, status: 500, error: message });
    }
    this.pending.clear();
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channels.EVENT, { type: 'index:error', message });
    }
  }

  private dispose(): void {
    sessions.delete(this.contentsId);
    this.shutdown();
    this.dead = true;
  }
}
