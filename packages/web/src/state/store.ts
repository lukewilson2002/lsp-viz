/**
 * App state: the navigation stack (the core of the app), per-view graph data
 * with a cache for instant Back, selection/hover, live index progress from the
 * WebSocket, the search palette, and browser-history mirroring.
 *
 * It also owns the two surfaces that read a node rather than the graph: the
 * card link panels and the sidebar. Both are backed by id-keyed response caches
 * (`nodeDetails`, `symbols`, `sources`, `sourceLinks`, `tree`) that `invalidate()` drops when
 * the index changes, plus UI bits that deliberately OUTLIVE a re-index because
 * they are preferences, not data: `expandedIO`, `sidebarTab`,
 * `detailCollapsed`. All of those are global rather than per-`ViewEntry`, so
 * they survive Back/forward and a popstate rebuild.
 */

import type {
  GraphNode,
  GraphViewResponse,
  IndexPhase,
  MetaResponse,
  NodeDetailResponse,
  NodeKind,
  SourceLinksResponse,
  SourceResponse,
  SymbolsResponse,
  TreeNode,
  ViewLevel,
  WsServerMessage,
} from '@lsp-viz/core';
import { create } from 'zustand';
import {
  fetchGraph,
  fetchMeta,
  fetchNodeDetail,
  fetchSource,
  fetchSourceLinks,
  fetchSymbols,
  fetchTree,
} from '../api/client';
import { isLeafSymbolKind, levelForViewParent, ROOT_NODE_ID } from '../levels';

/** Canvas pan/zoom — structurally identical to @xyflow/react's Viewport. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Which sidebar tab is showing. */
export type SidebarTab = 'files' | 'details';

/** Collapsible sections of the sidebar's Details tab. */
export type DetailSectionId = 'source' | 'symbols' | 'incoming' | 'outgoing';

/** One entry in the navigation stack. */
export interface ViewEntry {
  nodeId: string;
  name: string;
  kind: NodeKind;
  level: ViewLevel;
  /** Exact canvas viewport to restore on Back; null until first saved. */
  viewport: Viewport | null;
  selectionId: string | null;
  /** LOD override: render all children even past the visible-node cap. */
  showAll: boolean;
}

/** Data slot for an L5 (leaf symbol) view. */
export interface L5Data {
  nodeId: string;
  detail: NodeDetailResponse | null;
  source: SourceResponse | null;
  loading: boolean;
  error: string | null;
}

/** Live indexing progress mirrored from WS `index:progress` messages. */
export interface IndexProgressState {
  phase: IndexPhase;
  filesDone: number;
  filesTotal: number;
  currentFile: string | null;
  symbols: number | null;
  callEdges: number | null;
}

export interface NavigateOptions {
  /**
   * Land on the target's PARENT view with the target selected and centered
   * (portal double-click) instead of on the target's own view.
   */
  landOnParent?: boolean;
}

export interface AppState {
  meta: MetaResponse | null;
  /** initialize() outcome; 'error' shows the boot error screen. */
  bootState: 'idle' | 'loading' | 'ready' | 'error';
  bootError: string | null;

  /** Navigation stack; last entry is the current view. */
  stack: ViewEntry[];
  /** Per-nodeId cache of /api/graph responses (instant Back). */
  graphs: Record<string, GraphViewResponse>;
  /** True while the CURRENT view's graph is being fetched (cache miss). */
  graphLoading: boolean;
  graphError: string | null;

  /** Detail + source for the current L5 view (null when top is a canvas). */
  l5: L5Data | null;

  /**
   * Cached /api/node responses — feeds the cards' expanded link panels, the
   * sidebar's Details tab and its tab label, and the tree's proxy anchoring.
   * Invalidated with the graph cache on index:done.
   */
  nodeDetails: Record<string, NodeDetailResponse>;

  /**
   * Which node cards have their link panel open, keyed by node id. Global
   * (survives Back/forward); toggled from a card's links row, and read by
   * `nodeDimensions` so ELK lays out around the open card.
   */
  expandedIO: Record<string, boolean>;

  /**
   * Which sidebar tab is showing. GLOBAL, not per ViewEntry: selectionId is
   * already per-entry, so the tab is nearly a function of selection; the only
   * free bit is "user clicked back to Files while keeping the selection", and
   * threading that through makeEntry/entryCache/applySnapshot for one bit is
   * not worth it. Matches the expandedIO precedent.
   */
  sidebarTab: SidebarTab;

  /**
   * Collapsed detail sections. An absent key means expanded. Keyed by SECTION,
   * not by node id: "I don't want to read all the code" is a standing
   * preference about a KIND of information, so it must survive selection
   * changes, the DetailsPane remount, Back/forward and invalidate().
   */
  detailCollapsed: Partial<Record<DetailSectionId, boolean>>;

  /** Cached /api/symbols responses; cleared with nodeDetails on index:done. */
  symbols: Record<string, SymbolsResponse>;

  /** Cached /api/source responses; cleared with nodeDetails on index:done. */
  sources: Record<string, SourceResponse>;

  /**
   * Cached /api/links responses — the identifiers a node's source slice may
   * turn into links. Keyed by the node whose SLICE is shown (a file and a
   * function inside it get different sets), and dropped with the rest on
   * index:done, since a re-index moves the very ids these point at.
   */
  sourceLinks: Record<string, SourceLinksResponse>;

  /** Cached /api/tree root for the sidebar tree; refetched on index:done. */
  tree: TreeNode | null;
  treeError: string | null;

  /**
   * Bumped once per `invalidate()`. The caches above are id-keyed, so a
   * component that fetches into them from an effect keyed on the id alone
   * never re-runs when they are wiped — it just renders its loading state
   * forever. Watching the cached VALUE instead only heals components that read
   * exactly one cache. This is the single "the index moved, refetch what you
   * needed" signal; put it in the deps of any such effect.
   */
  dataEpoch: number;

  hoverId: string | null;

  /** Node to center after the next canvas layout (portal landings). */
  pendingCenterId: string | null;

  /** Search palette (Cmd/Ctrl-K). */
  paletteOpen: boolean;

  /** Live WS index progress; null when idle. */
  indexProgress: IndexProgressState | null;
  indexError: string | null;

  initialize: () => Promise<void>;
  drillInto: (node: GraphNode) => void;
  goBack: () => void;
  goToDepth: (depth: number) => void;
  navigateToNode: (id: string, opts?: NavigateOptions) => Promise<void>;
  select: (id: string | null) => void;
  setHover: (id: string | null) => void;
  saveViewport: (viewport: Viewport) => void;
  /** Expand the "+N more" cluster: show every child, then re-fit. */
  setShowAll: () => void;
  setPaletteOpen: (open: boolean) => void;
  clearPendingCenter: () => void;
  /** Fetch-and-cache one node's detail; null on failure. In-flight deduped. */
  ensureNodeDetail: (id: string) => Promise<NodeDetailResponse | null>;
  /** Toggle a node card's links panel (kicks off the detail fetch). */
  toggleIOExpanded: (id: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleDetailSection: (id: DetailSectionId) => void;
  /** Fetch-and-cache one node's declaration list; null on failure. */
  ensureSymbols: (id: string) => Promise<SymbolsResponse | null>;
  /** Fetch-and-cache one node's source slice; null when there is none. */
  ensureSource: (id: string) => Promise<SourceResponse | null>;
  /** Fetch-and-cache the clickable identifiers for one node's slice. */
  ensureSourceLinks: (id: string) => Promise<SourceLinksResponse | null>;
  /** Fetch-and-cache the sidebar directory tree. */
  ensureTree: () => Promise<void>;
  /** Feed one WebSocket server message into the store. */
  handleWsMessage: (msg: WsServerMessage) => void;
  /** Drop all cached graph data and refetch the current view + meta. */
  invalidate: () => Promise<void>;
}

function makeEntry(node: Pick<GraphNode, 'id' | 'name' | 'kind'>): ViewEntry {
  return {
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    level: levelForViewParent(node.kind),
    viewport: null,
    selectionId: null,
    showAll: false,
  };
}

/**
 * History mirroring: every browser-history entry stores a snapshot of the
 * whole navigation stack (ids + names + kinds). popstate rebuilds the stack
 * from the landed entry's snapshot, so Back/Forward stay correct even after
 * navigateToNode rebuilt the stack (search / portal / sidebar jumps) —
 * a depth-only scheme goes dead there. Viewports/selection are re-attached
 * from live entries (same index) or from a per-node cache.
 */
interface EntrySnapshot {
  nodeId: string;
  name: string;
  kind: NodeKind;
}

interface HistoryState {
  lspVizStack: EntrySnapshot[];
}

function snapshotOf(stack: readonly ViewEntry[]): EntrySnapshot[] {
  return stack.map((e) => ({ nodeId: e.nodeId, name: e.name, kind: e.kind }));
}

function historySnapshot(state: unknown): EntrySnapshot[] | null {
  if (typeof state !== 'object' || state === null || !('lspVizStack' in state)) return null;
  const snap = (state as HistoryState).lspVizStack;
  if (!Array.isArray(snap) || snap.length === 0) return null;
  for (const entry of snap) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as EntrySnapshot).nodeId !== 'string' ||
      typeof (entry as EntrySnapshot).name !== 'string' ||
      typeof (entry as EntrySnapshot).kind !== 'string'
    ) {
      return null;
    }
  }
  return snap;
}

let historyAttached = false;
/** A history.back() we issued that has not yet landed in popstate. */
let backInFlight = false;

export const useAppStore = create<AppState>()((set, get) => {
  /** Throttle marker for view refetches while index:progress streams. */
  let lastProgressRefetch = 0;

  /** In-flight /api/node fetches, deduped per id. */
  const detailFetches = new Map<string, Promise<NodeDetailResponse | null>>();
  const symbolFetches = new Map<string, Promise<SymbolsResponse | null>>();
  const sourceFetches = new Map<string, Promise<SourceResponse | null>>();
  const linkFetches = new Map<string, Promise<SourceLinksResponse | null>>();
  let treeFetching = false;

  /**
   * Last-known ViewEntry per node id: restores viewport/selection/showAll
   * when a node's view re-enters the stack via Back/Forward after a rebuild.
   */
  const entryCache = new Map<string, ViewEntry>();

  const cacheEntries = (stack: readonly ViewEntry[]): void => {
    for (const entry of stack) entryCache.set(entry.nodeId, entry);
  };

  /** Make the store's stack match a history entry's snapshot. */
  const applySnapshot = (snap: readonly EntrySnapshot[]): void => {
    const { stack } = get();
    cacheEntries(stack);
    const next: ViewEntry[] = snap.map((s, index) => {
      const live = stack[index];
      if (live && live.nodeId === s.nodeId) return live;
      return entryCache.get(s.nodeId) ?? makeEntry({ id: s.nodeId, name: s.name, kind: s.kind });
    });
    set({ stack: next, graphError: null, pendingCenterId: null });
    void ensureTopData();
  };

  const attachHistory = (): void => {
    if (historyAttached) return;
    historyAttached = true;
    window.addEventListener('popstate', (event: PopStateEvent) => {
      backInFlight = false;
      const snap = historySnapshot(event.state);
      if (snap === null) return;
      applySnapshot(snap);
    });
  };

  /** Replace the top entry immutably. */
  const patchTop = (patch: Partial<ViewEntry>): void => {
    const { stack } = get();
    const top = stack[stack.length - 1];
    if (!top) return;
    set({ stack: [...stack.slice(0, -1), { ...top, ...patch }] });
  };

  /** Make sure the data for the current top entry is (being) loaded. */
  const ensureTopData = async (): Promise<void> => {
    const { stack } = get();
    const top = stack[stack.length - 1];
    if (!top) return;

    if (top.level === 5) {
      if (get().graphLoading) set({ graphLoading: false });
      await ensureL5Data(top.nodeId);
      return;
    }

    set({ l5: null });
    if (get().graphs[top.nodeId]) {
      // An abandoned fetch for a previous entry must not leave the cached
      // view stuck behind the loading overlay.
      if (get().graphLoading) set({ graphLoading: false });
      return;
    }

    set({ graphLoading: true, graphError: null });
    try {
      const graph = await fetchGraph(top.nodeId);
      // Guard against a nav that happened while the fetch was in flight.
      set((s) => ({
        graphs: { ...s.graphs, [top.nodeId]: graph },
        graphLoading: currentTop(s)?.nodeId !== top.nodeId ? s.graphLoading : false,
      }));
    } catch (err) {
      if (currentTop(get())?.nodeId === top.nodeId) {
        set({ graphLoading: false, graphError: errorMessage(err) });
      }
    }
  };

  const ensureL5Data = async (nodeId: string): Promise<void> => {
    const existing = get().l5;
    if (existing && existing.nodeId === nodeId && (existing.detail || existing.loading)) return;

    set({ l5: { nodeId, detail: null, source: null, loading: true, error: null } });
    try {
      const [detail, source] = await Promise.all([
        fetchNodeDetail(nodeId),
        fetchSource(nodeId).catch(() => null),
      ]);
      if (get().l5?.nodeId === nodeId) {
        set({ l5: { nodeId, detail, source, loading: false, error: null } });
      }
    } catch (err) {
      if (get().l5?.nodeId === nodeId) {
        set({ l5: { nodeId, detail: null, source: null, loading: false, error: errorMessage(err) } });
      }
    }
  };

  /**
   * Silently refetch the current view's data (no loading spinner) — used for
   * progressive updates while indexing streams.
   */
  const refetchCurrent = async (): Promise<void> => {
    const top = currentTop(get());
    if (!top) return;
    if (top.level === 5) {
      try {
        const [detail, source] = await Promise.all([
          fetchNodeDetail(top.nodeId),
          fetchSource(top.nodeId).catch(() => null),
        ]);
        if (currentTop(get())?.nodeId === top.nodeId) {
          set({ l5: { nodeId: top.nodeId, detail, source, loading: false, error: null } });
        }
      } catch {
        // best-effort refresh
      }
      return;
    }
    try {
      const graph = await fetchGraph(top.nodeId);
      set((s) => ({ graphs: { ...s.graphs, [top.nodeId]: graph } }));
    } catch {
      // best-effort refresh
    }
  };

  /** Push new stack state + mirror it into browser history. */
  const pushStack = (stack: ViewEntry[]): void => {
    cacheEntries(get().stack);
    set({ stack, graphError: null });
    const state: HistoryState = { lspVizStack: snapshotOf(stack) };
    window.history.pushState(state, '');
    void ensureTopData();
  };

  return {
    meta: null,
    bootState: 'idle',
    bootError: null,
    stack: [],
    graphs: {},
    graphLoading: false,
    graphError: null,
    l5: null,
    nodeDetails: {},
    expandedIO: {},
    sidebarTab: 'files',
    detailCollapsed: {},
    symbols: {},
    sources: {},
    sourceLinks: {},
    tree: null,
    treeError: null,
    dataEpoch: 0,
    hoverId: null,
    pendingCenterId: null,
    paletteOpen: false,
    indexProgress: null,
    indexError: null,

    initialize: async () => {
      if (get().bootState === 'loading' || get().bootState === 'ready') return;
      attachHistory();
      set({ bootState: 'loading', bootError: null });
      try {
        const meta = await fetchMeta();
        const rootEntry: ViewEntry = {
          nodeId: ROOT_NODE_ID,
          name: meta.repoName,
          kind: 'workspace',
          level: 1,
          viewport: null,
          selectionId: null,
          showAll: false,
        };
        set({ meta, bootState: 'ready', stack: [rootEntry] });
        const state: HistoryState = { lspVizStack: snapshotOf([rootEntry]) };
        window.history.replaceState(state, '');
        await ensureTopData();
      } catch (err) {
        set({ bootState: 'error', bootError: errorMessage(err) });
      }
    },

    drillInto: (node) => {
      const { stack } = get();
      const top = stack[stack.length - 1];
      if (!top) return;
      if (node.id === top.nodeId) return;
      // Viewport was already saved into the current entry by onMoveEnd →
      // saveViewport; pushing keeps it for exact restore on Back.
      set({ pendingCenterId: null });
      pushStack([...stack, makeEntry(node)]);
    },

    goBack: () => {
      if (get().stack.length <= 1) return;
      // The stack only shrinks when the async popstate lands, so key-repeat
      // would otherwise issue extra back()s against a stale length and could
      // traverse past the app's own history entries.
      if (backInFlight) return;
      backInFlight = true;
      // Route through browser history so it stays in sync; the popstate
      // handler applies the landed entry's stack snapshot.
      window.history.back();
    },

    goToDepth: (depth) => {
      const { stack } = get();
      const target = Math.max(1, Math.min(depth, stack.length));
      if (target >= stack.length) return;
      // Truncate to the clicked crumb. Mirrored as a NEW history entry
      // (never history.go(-n)): after a cross-jump rebuilt the stack, the
      // entries behind us belong to the old branch, so a relative jump would
      // land on the wrong view. Keeping the same entry objects preserves the
      // saved viewport/selection for the exact-restore contract.
      pushStack(stack.slice(0, target));
    },

    navigateToNode: async (id, opts) => {
      try {
        const detail = await fetchNodeDetail(id);
        set((s) => ({ nodeDetails: { ...s.nodeDetails, [id]: detail } }));
        const { node, ancestors } = detail;
        // ancestors = [root, ..., direct parent]
        const stack: ViewEntry[] = ancestors.map((a) =>
          a.id === ROOT_NODE_ID || a.kind === 'workspace'
            ? makeEntry({ id: a.id, name: get().meta?.repoName ?? a.name, kind: a.kind })
            : makeEntry(a),
        );
        // Pre-select the target in its parent view so it's highlighted there.
        const parentEntry = stack[stack.length - 1];
        if (parentEntry) parentEntry.selectionId = node.id;

        if (opts?.landOnParent === true && parentEntry) {
          // Portal landing: the parent view IS the destination; center the
          // target after layout. This writes parentEntry.selectionId directly
          // rather than going through select(), so the tab is set by hand.
          set({ pendingCenterId: node.id, sidebarTab: 'details' });
          pushStack(stack);
          return;
        }

        set({ pendingCenterId: null });
        // Leaf symbol → L5 entry; container/file/class → its own canvas view.
        stack.push(makeEntry(node));
        if (isLeafSymbolKind(node.kind)) {
          // Seed the L5 slot with the detail we already have.
          set({ l5: { nodeId: node.id, detail, source: null, loading: false, error: null } });
          void fetchSource(node.id)
            .then((source) => {
              const l5 = get().l5;
              if (l5?.nodeId === node.id) set({ l5: { ...l5, source } });
            })
            .catch(() => undefined);
        }
        pushStack(stack);
      } catch (err) {
        set({ graphError: errorMessage(err) });
      }
    },

    select: (id) => {
      patchTop({ selectionId: id });
      // Selecting opens the details tab; deselecting falls back to Files.
      // Sidebar.tsx re-derives this from the live selection, so a cluster
      // pseudo-selection still lands on Files without a special case here
      // (the store must not import from canvas/).
      set({ sidebarTab: id === null ? 'files' : 'details' });
    },

    setHover: (id) => {
      set({ hoverId: id });
    },

    saveViewport: (viewport) => {
      patchTop({ viewport });
    },

    setShowAll: () => {
      // Clearing the saved viewport makes the canvas re-fit around the
      // expanded node set instead of restoring the pre-expansion camera.
      patchTop({ showAll: true, viewport: null });
    },

    setPaletteOpen: (open) => {
      set({ paletteOpen: open });
    },

    clearPendingCenter: () => {
      if (get().pendingCenterId !== null) set({ pendingCenterId: null });
    },

    ensureNodeDetail: async (id) => {
      const cached = get().nodeDetails[id];
      if (cached) return cached;
      const inFlight = detailFetches.get(id);
      if (inFlight) return inFlight;
      const promise = fetchNodeDetail(id)
        .then((detail) => {
          set((s) => ({ nodeDetails: { ...s.nodeDetails, [id]: detail } }));
          return detail as NodeDetailResponse | null;
        })
        .catch(() => null)
        .finally(() => {
          detailFetches.delete(id);
        });
      detailFetches.set(id, promise);
      return promise;
    },

    toggleIOExpanded: (id) => {
      const open = get().expandedIO[id] === true;
      set((s) => ({ expandedIO: { ...s.expandedIO, [id]: !open } }));
      if (!open && !get().nodeDetails[id]) void get().ensureNodeDetail(id);
    },

    setSidebarTab: (tab) => {
      set({ sidebarTab: tab });
    },

    toggleDetailSection: (id) => {
      set((s) => ({
        detailCollapsed: { ...s.detailCollapsed, [id]: s.detailCollapsed[id] !== true },
      }));
    },

    ensureSymbols: async (id) => {
      const cached = get().symbols[id];
      if (cached) return cached;
      const inFlight = symbolFetches.get(id);
      if (inFlight) return inFlight;
      const promise = fetchSymbols(id)
        .then((res) => {
          set((s) => ({ symbols: { ...s.symbols, [id]: res } }));
          return res as SymbolsResponse | null;
        })
        .catch(() => null)
        .finally(() => {
          symbolFetches.delete(id);
        });
      symbolFetches.set(id, promise);
      return promise;
    },

    ensureSource: async (id) => {
      const cached = get().sources[id];
      if (cached) return cached;
      const inFlight = sourceFetches.get(id);
      if (inFlight) return inFlight;
      const promise = fetchSource(id)
        .then((res) => {
          set((s) => ({ sources: { ...s.sources, [id]: res } }));
          return res as SourceResponse | null;
        })
        .catch(() => null)
        .finally(() => {
          sourceFetches.delete(id);
        });
      sourceFetches.set(id, promise);
      return promise;
    },

    ensureSourceLinks: async (id) => {
      const cached = get().sourceLinks[id];
      if (cached) return cached;
      const inFlight = linkFetches.get(id);
      if (inFlight) return inFlight;
      const promise = fetchSourceLinks(id)
        .then((res) => {
          set((s) => ({ sourceLinks: { ...s.sourceLinks, [id]: res } }));
          return res as SourceLinksResponse | null;
        })
        .catch(() => null)
        .finally(() => {
          linkFetches.delete(id);
        });
      linkFetches.set(id, promise);
      return promise;
    },

    ensureTree: async () => {
      if (get().tree !== null || treeFetching) return;
      treeFetching = true;
      try {
        const res = await fetchTree();
        set({ tree: res.root, treeError: null });
      } catch (err) {
        set({ treeError: errorMessage(err) });
      } finally {
        treeFetching = false;
      }
    },

    handleWsMessage: (msg) => {
      switch (msg.type) {
        case 'index:progress': {
          const progress: IndexProgressState = {
            phase: msg.phase,
            filesDone: msg.filesDone,
            filesTotal: msg.filesTotal,
            currentFile: msg.currentFile ?? null,
            symbols: msg.symbols ?? null,
            callEdges: msg.callEdges ?? null,
          };
          set((s) => ({
            indexProgress: progress,
            indexError: null,
            meta: s.meta ? { ...s.meta, indexing: true } : s.meta,
          }));
          const now = Date.now();
          if (now - lastProgressRefetch >= 2000) {
            lastProgressRefetch = now;
            void refetchCurrent();
          }
          break;
        }
        case 'index:done': {
          lastProgressRefetch = 0;
          set({ indexProgress: null, indexError: null });
          void get().invalidate();
          break;
        }
        case 'index:error': {
          set({ indexProgress: null, indexError: msg.message });
          void fetchMeta()
            .then((meta) => set({ meta }))
            .catch(() => undefined);
          break;
        }
      }
    },

    invalidate: async () => {
      detailFetches.clear();
      symbolFetches.clear();
      sourceFetches.clear();
      linkFetches.clear();
      // sidebarTab / detailCollapsed deliberately survive: they are UI
      // preferences, not indexed data.
      set((s) => ({
        graphs: {},
        l5: null,
        nodeDetails: {},
        symbols: {},
        sources: {},
        sourceLinks: {},
        tree: null,
        treeError: null,
        // Wakes the effects that fetch into the caches just emptied.
        dataEpoch: s.dataEpoch + 1,
      }));
      try {
        const meta = await fetchMeta();
        set({ meta });
      } catch {
        // meta refresh is best-effort
      }
      await ensureTopData();
    },
  };
});

function currentTop(state: Pick<AppState, 'stack'>): ViewEntry | undefined {
  return state.stack[state.stack.length - 1];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Selector helpers. */
export function selectTopEntry(state: AppState): ViewEntry | undefined {
  return state.stack[state.stack.length - 1];
}

export function selectCurrentGraph(state: AppState): GraphViewResponse | undefined {
  const top = selectTopEntry(state);
  return top ? state.graphs[top.nodeId] : undefined;
}
