/**
 * Typed fetch wrappers for the lsp-viz HTTP API. Response shapes come from
 * @lsp-viz/core (type-only import — never a value import).
 */

import type {
  GraphViewResponse,
  IndexRequestBody,
  MetaResponse,
  NodeDetailResponse,
  SearchResponse,
  SourceLinksResponse,
  SourceResponse,
  SymbolsResponse,
  TreeResponse,
} from '@lsp-viz/core';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
}

/** GET /api/graph?parent=<nodeId> — children of a node + edges among them. */
export function fetchGraph(parentId: string): Promise<GraphViewResponse> {
  return request<GraphViewResponse>(`/api/graph?parent=${encodeURIComponent(parentId)}`);
}

/** GET /api/node/:id — full node detail incl. call links and ancestors. */
export function fetchNodeDetail(id: string): Promise<NodeDetailResponse> {
  return request<NodeDetailResponse>(`/api/node/${encodeURIComponent(id)}`);
}

/** GET /api/source/:id — source text for a node's range, read from disk. */
export function fetchSource(id: string): Promise<SourceResponse> {
  return request<SourceResponse>(`/api/source/${encodeURIComponent(id)}`);
}

/** GET /api/links/:id — identifiers in this node's source that the graph knows. */
export function fetchSourceLinks(id: string): Promise<SourceLinksResponse> {
  return request<SourceLinksResponse>(`/api/links/${encodeURIComponent(id)}`);
}

/** GET /api/search?q= — fuzzy symbol search. */
export function fetchSearch(query: string): Promise<SearchResponse> {
  return request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);
}

/** GET /api/symbols/:id — declarations in/under a node, grouped by file. */
export function fetchSymbols(id: string): Promise<SymbolsResponse> {
  return request<SymbolsResponse>(`/api/symbols/${encodeURIComponent(id)}`);
}

/** GET /api/tree — containment tree (containers + files) for the sidebar. */
export function fetchTree(): Promise<TreeResponse> {
  return request<TreeResponse>('/api/tree');
}

/** GET /api/meta — repo info + index status. */
export function fetchMeta(): Promise<MetaResponse> {
  return request<MetaResponse>('/api/meta');
}

/** POST /api/index — kick off a (re-)index run. 409s if already running. */
export function startIndex(body: IndexRequestBody = {}): Promise<{ started: boolean }> {
  return request<{ started: boolean }>('/api/index', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** WebSocket URL for index progress (dev: proxied by vite; prod: same host). */
export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
