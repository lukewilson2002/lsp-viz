/**
 * Every shape that crosses a process boundary. Both ends of each hop import
 * this file, so a message can never be half-changed.
 */

import type { ApiParams, ApiRouteName, WsServerMessage } from '@lsp-viz/core';
import type { IndexMode } from '@lsp-viz/indexer';

/**
 * Every API answer, success or failure — main -> renderer.
 *
 * Failures ride back as a VALUE rather than a rejected promise on purpose: an
 * Error thrown inside `ipcMain.handle` reaches the renderer as a string with
 * "Error invoking remote method ..." prepended and the status gone, and the
 * frontend's `ApiError` needs that status (a 404 renders "not indexed yet", a
 * 409 is a benign "already running").
 */
export type ApiReply<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

/** Main -> worker. */
export type WorkerRequest =
  | { type: 'call'; id: number; route: ApiRouteName; params: ApiParams }
  | { type: 'index'; mode: IndexMode }
  | { type: 'shutdown' };

/** Worker -> main. */
export type WorkerMessage =
  | { type: 'ready'; repoRoot: string; dbPath: string }
  | { type: 'reply'; id: number; reply: ApiReply }
  | { type: 'event'; message: WsServerMessage }
  /** The worker could not start at all — nothing it owns is usable. */
  | { type: 'fatal'; message: string };
