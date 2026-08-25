/**
 * App state: the navigation stack (the core of the app), per-view graph data
 * with a cache for instant Back, selection/hover, live index progress from the
 * WebSocket, the search palette, and browser-history mirroring.
 */

import type {
  GraphNode,
  GraphViewResponse,
  IndexPhase,
  MetaResponse,
  NodeDetailResponse,
  NodeKind,
  SourceResponse,
  TreeNode,
  ViewLevel,
  WsServerMessage,
} from '@lsp-viz/core';
import { create } from 'zustand';
import { fetchGraph, fetchMeta, fetchNodeDetail, fetchSource, fetchTree } from '../api/client';
import { isLeafSymbolKind, levelForViewParent, ROOT_NODE_ID } from '../levels';

/** Canvas pan/zoom — structurally identical to @xyflow/react's Viewport. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

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
   * Cached /api/node responses — feeds in-graph expanders, hover popovers and
   * the sidebar. Invalidated with the graph cache on index:done.
   */
  nodeDetails: Record<string, NodeDetailResponse>;

  /**
   * In/out expansion state per node id, global (survives Back/forward).
   * Toggled from the node cards' in/out badge.
   */
  expandedIO: Record<string, boolean>;

  /** Cached /api/tree root for the sidebar tree; refetched on index:done. */
  tree: TreeNode | null;
  treeError: string | null;

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
  /** Toggle a node card's in/out expansion (kicks off the detail fetch). */
  toggleIOExpanded: (id: string) => void;
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
 * navigateToNode rebuilt the stack (search / portal / inspector jumps) —
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
    tree: null,
    treeError: null,
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
          // target after layout.
          set({ pendingCenterId: node.id });
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
      set({ graphs: {}, l5: null, nodeDetails: {}, tree: null, treeError: null });
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
