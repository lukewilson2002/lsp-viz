/**
 * The API, as typed functions. Response shapes come from @lsp-viz/core
 * (type-only import — never a value import).
 *
 * These signatures are the frontend's whole view of the backend; which wire
 * carries them (HTTP+WebSocket under the CLI, Electron IPC under the desktop
 * app) is `transport.ts`'s business and nothing here or above may depend on it.
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
import { transport } from './transport';

export { ApiError, desktopPlatform, isDesktop } from './transport';

/** Children of a node + edges among them. */
export function fetchGraph(parentId: string): Promise<GraphViewResponse> {
  return transport().invoke<GraphViewResponse>('graph', { parent: parentId });
}

/** Full node detail incl. call links and ancestors. */
export function fetchNodeDetail(id: string): Promise<NodeDetailResponse> {
  return transport().invoke<NodeDetailResponse>('nodeDetail', { id });
}

/** Source text for a node's range, read from disk. */
export function fetchSource(id: string): Promise<SourceResponse> {
  return transport().invoke<SourceResponse>('source', { id });
}

/** Identifiers in this node's source that the graph knows. */
export function fetchSourceLinks(id: string): Promise<SourceLinksResponse> {
  return transport().invoke<SourceLinksResponse>('links', { id });
}

/** Fuzzy symbol search. */
export function fetchSearch(query: string): Promise<SearchResponse> {
  return transport().invoke<SearchResponse>('search', { q: query });
}

/** Declarations in/under a node, grouped by file. */
export function fetchSymbols(id: string): Promise<SymbolsResponse> {
  return transport().invoke<SymbolsResponse>('symbols', { id });
}

/** Containment tree (containers + files) for the sidebar. */
export function fetchTree(): Promise<TreeResponse> {
  return transport().invoke<TreeResponse>('tree');
}

/** Repo info + index status. */
export function fetchMeta(): Promise<MetaResponse> {
  return transport().invoke<MetaResponse>('meta');
}

/** Kick off a (re-)index run. Rejects with a 409 if one is already running. */
export function startIndex(body: IndexRequestBody = {}): Promise<{ started: boolean }> {
  return transport().invoke<{ started: boolean }>('startIndex', { full: body.full === true });
}

/** Subscribe to index progress on whichever wire this host provides. */
export function subscribeIndexEvents(
  handle: Parameters<ReturnType<typeof transport>['subscribe']>[0],
): () => void {
  return transport().subscribe(handle);
}
