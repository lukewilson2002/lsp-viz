/**
 * WebSocket client for index progress. Connects to (wss|ws)://host/ws,
 * reconnects with exponential backoff, and feeds every WsServerMessage into
 * the handler (the store).
 */

import type { WsServerMessage } from '@lsp-viz/core';
import { wsUrl } from './api/client';

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

/** Open the /ws connection; returns a dispose function. */
export function connectWs(handle: (msg: WsServerMessage) => void): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let attempt = 0;

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== null) return;
    const delay =
      Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) + Math.random() * 250;
    attempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (disposed) return;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data) as WsServerMessage;
      } catch {
        return;
      }
      handle(msg);
    };
    socket.onclose = () => {
      socket = null;
      scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  };

  open();

  return () => {
    disposed = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}
