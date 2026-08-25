import Database from 'better-sqlite3';
import { computeAggregates } from './aggregate.js';
import { aggregateEdgeId, edgeId } from './ids.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeAttrs, NodeKind, Range } from './types.js';
import { ROOT_NODE_ID, SYMBOL_KINDS, isContainerKind } from './types.js';

const SCHEMA_VERSION = '2';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL,
  parent_id      TEXT,
  language       TEXT NOT NULL,
  range_json     TEXT,
  selection_json TEXT,
  signature      TEXT,
  detail         TEXT,
  attrs_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_name   ON nodes(name);
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  source_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_from   ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_path);
CREATE TABLE IF NOT EXISTS aggregate_edges (
  id        TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  count     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agg_parent ON aggregate_edges(parent_id);
CREATE TABLE IF NOT EXISTS files (
  path            TEXT PRIMARY KEY,
  mtime_ms        INTEGER NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  structural_done INTEGER NOT NULL DEFAULT 0,
  semantic_done   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL,
  to_path     TEXT NOT NULL,
  sel_line    INTEGER NOT NULL,
  sel_char    INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  source_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_source ON pending_calls(source_path);
`;

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  path: string;
  parent_id: string | null;
  language: string;
  range_json: string | null;
  selection_json: string | null;
  signature: string | null;
  detail: string | null;
  attrs_json: string | null;
}

interface EdgeRow {
  id: string;
  kind: string;
  from_id: string;
  to_id: string;
  count: number;
  source_path: string | null;
}

interface AggRow {
  id: string;
  parent_id: string;
  kind: string;
  from_id: string;
  to_id: string;
  count: number;
}

interface FileRow {
  path: string;
  mtime_ms: number;
  size: number;
  structural_done: number;
  semantic_done: number;
}

export interface FileRecord {
  path: string;
  mtimeMs: number;
  size: number;
  structuralDone: boolean;
  semanticDone: boolean;
}

/** An unresolved call edge awaiting its target file's semantic pass. */
export interface PendingCallRecord {
  fromId: string;
  toPath: string;
  /** Target selectionRange start (0-based, LSP convention). */
  selLine: number;
  selChar: number;
  count: number;
  sourcePath: string;
}

export interface ViewGraph {
  parent: GraphNode;
  children: GraphNode[];
  edges: GraphEdge[];
  externalEdges: GraphEdge[];
  externalNodes: GraphNode[];
}

export interface CallLinkRow {
  edge: GraphEdge;
  node: GraphNode;
}

export interface StoreStats {
  nodes: number;
  edges: number;
  aggregateEdges: number;
  files: number;
}

/** Edge kinds that connect symbols (as opposed to files/containers). */
const SYMBOL_EDGE_KINDS: readonly EdgeKind[] = ['calls', 'references', 'extends', 'implements'];

/** Node kinds a source file can own — deleteFileData's cleanup scope. */
const FILE_OWNED_KINDS: readonly NodeKind[] = ['file', ...SYMBOL_KINDS];

function rowToNode(row: NodeRow): GraphNode {
  const node: GraphNode = {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    path: row.path,
    parentId: row.parent_id,
    language: row.language,
  };
  if (row.range_json) node.range = JSON.parse(row.range_json) as Range;
  if (row.selection_json) node.selectionRange = JSON.parse(row.selection_json) as Range;
  if (row.signature !== null) node.signature = row.signature;
  if (row.detail !== null) node.detail = row.detail;
  if (row.attrs_json) node.attrs = JSON.parse(row.attrs_json) as NodeAttrs;
  return node;
}

function rowToEdge(row: EdgeRow): GraphEdge {
  const edge: GraphEdge = {
    id: row.id,
    kind: row.kind as EdgeKind,
    from: row.from_id,
    to: row.to_id,
    count: row.count,
  };
  if (row.source_path !== null) edge.sourcePath = row.source_path;
  return edge;
}

function aggRowToEdge(row: AggRow): GraphEdge {
  return {
    id: row.id,
    kind: row.kind as EdgeKind,
    from: row.from_id,
    to: row.to_id,
    count: row.count,
  };
}

function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    mtimeMs: row.mtime_ms,
    size: row.size,
    structuralDone: row.structural_done === 1,
    semanticDone: row.semantic_done === 1,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class GraphStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    const existing = this.getMeta('schemaVersion');
    if (existing === null) {
      this.setMeta('schemaVersion', SCHEMA_VERSION);
    } else if (existing !== SCHEMA_VERSION) {
      // Incompatible old database: wipe and start over.
      this.clearAll();
      this.setMeta('schemaVersion', SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---------------------------------------------------------------- writes

  upsertNodes(nodes: readonly GraphNode[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO nodes
         (id, kind, name, path, parent_id, language, range_json, selection_json, signature, detail, attrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((items: readonly GraphNode[]) => {
      for (const n of items) {
        stmt.run(
          n.id,
          n.kind,
          n.name,
          n.path,
          n.parentId,
          n.language,
          n.range ? JSON.stringify(n.range) : null,
          n.selectionRange ? JSON.stringify(n.selectionRange) : null,
          n.signature ?? null,
          n.detail ?? null,
          n.attrs ? JSON.stringify(n.attrs) : null,
        );
      }
    });
    run(nodes);
  }

  /** Merge a partial update (signature, attrs, ...) into an existing node. */
  updateNode(id: string, patch: Partial<Pick<GraphNode, 'signature' | 'detail' | 'attrs' | 'range' | 'selectionRange'>>): void {
    const existing = this.getNode(id);
    if (!existing) return;
    this.upsertNodes([{ ...existing, ...patch }]);
  }

  upsertEdges(edges: readonly GraphEdge[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO edges (id, kind, from_id, to_id, count, source_path)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET count = excluded.count, source_path = excluded.source_path`,
    );
    const run = this.db.transaction((items: readonly GraphEdge[]) => {
      for (const e of items) {
        stmt.run(e.id, e.kind, e.from, e.to, e.count, e.sourcePath ?? null);
      }
    });
    run(edges);
  }

  /**
   * Add weight to an edge, creating it if absent. Used when several call sites
   * in one file hit the same target.
   */
  addEdge(kind: EdgeKind, from: string, to: string, count: number, sourcePath?: string): void {
    const id = edgeId(kind, from, to);
    this.db
      .prepare(
        `INSERT INTO edges (id, kind, from_id, to_id, count, source_path)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET count = edges.count + excluded.count`,
      )
      .run(id, kind, from, to, count, sourcePath ?? null);
  }

  /** Remove everything derived from one source file (before re-crawling it). */
  deleteFileData(path: string): void {
    this.db.transaction(() => this.deleteFileDataInner(path))();
  }

  /** Batch form of deleteFileData: every path cleaned up in one transaction. */
  deleteFilesData(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.db.transaction((items: readonly string[]) => {
      for (const path of items) this.deleteFileDataInner(path);
    })(paths);
  }

  private deleteFileDataInner(path: string): void {
    const kindList = FILE_OWNED_KINDS.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM nodes WHERE path = ? AND kind IN (${kindList})`)
      .run(path, ...FILE_OWNED_KINDS);
    this.db.prepare('DELETE FROM edges WHERE source_path = ?').run(path);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM pending_calls WHERE source_path = ?').run(path);
  }

  /** Full wipe (all graph + file data; meta preserved except index markers). */
  clearAll(): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM nodes').run();
      this.db.prepare('DELETE FROM edges').run();
      this.db.prepare('DELETE FROM aggregate_edges').run();
      this.db.prepare('DELETE FROM files').run();
      this.db.prepare('DELETE FROM pending_calls').run();
    });
    run();
  }

  // ------------------------------------------------------------ pending calls

  /**
   * Call edges whose targets could not be resolved yet (target file not
   * semantically indexed at emit time). Persisted so an interrupted or crashed
   * run can retry them later instead of silently losing the edges.
   */
  addPendingCalls(rows: readonly PendingCallRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO pending_calls (from_id, to_path, sel_line, sel_char, count, source_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((items: readonly PendingCallRecord[]) => {
      for (const r of items) {
        stmt.run(r.fromId, r.toPath, r.selLine, r.selChar, r.count, r.sourcePath);
      }
    });
    run(rows);
  }

  listPendingCalls(): (PendingCallRecord & { id: number })[] {
    const rows = this.db.prepare('SELECT * FROM pending_calls').all() as {
      id: number;
      from_id: string;
      to_path: string;
      sel_line: number;
      sel_char: number;
      count: number;
      source_path: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      fromId: r.from_id,
      toPath: r.to_path,
      selLine: r.sel_line,
      selChar: r.sel_char,
      count: r.count,
      sourcePath: r.source_path,
    }));
  }

  deletePendingCalls(ids: readonly number[]): void {
    const run = this.db.transaction((items: readonly number[]) => {
      const stmt = this.db.prepare('DELETE FROM pending_calls WHERE id = ?');
      for (const id of items) stmt.run(id);
    });
    run(ids);
  }

  // ------------------------------------------------------------ housekeeping

  /**
   * Delete container (package/directory) nodes that no longer contain
   * anything — diff re-indexing only removes file/symbol nodes, so vanished
   * directories would otherwise linger as empty drillable views forever.
   * Iterates bottom-up; never touches the workspace root.
   */
  gcEmptyContainers(): number {
    let removed = 0;
    const stmt = this.db.prepare(
      `DELETE FROM nodes WHERE kind IN ('package', 'directory')
         AND id != ?
         AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id)`,
    );
    // Each pass can empty the next container up the chain.
    for (;;) {
      const { changes } = stmt.run(ROOT_NODE_ID);
      removed += changes;
      if (changes === 0) break;
    }
    return removed;
  }

  /**
   * Drop edges pointing at nodes that no longer exist (e.g. a symbol removed
   * from a re-indexed file while its callers' files were unchanged). Run at
   * the end of an index run — mid-run, targets may simply not be re-crawled
   * yet, and deterministic ids make surviving edges valid again.
   */
  pruneDanglingEdges(): number {
    const { changes } = this.db
      .prepare(
        `DELETE FROM edges WHERE
           from_id NOT IN (SELECT id FROM nodes)
           OR to_id NOT IN (SELECT id FROM nodes)`,
      )
      .run();
    return changes;
  }

  // ---------------------------------------------------------------- reads

  getNode(id: string): GraphNode | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getNodes(ids: readonly string[]): GraphNode[] {
    const out: GraphNode[] = [];
    for (const group of chunk(ids, 400)) {
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${group.map(() => '?').join(',')})`)
        .all(...group) as NodeRow[];
      out.push(...rows.map(rowToNode));
    }
    return out;
  }

  /** All nodes whose path is exactly `path` (the file node + its symbols). */
  getNodesByPath(path: string): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE path = ?').all(path) as NodeRow[];
    return rows.map(rowToNode);
  }

  getChildren(parentId: string): GraphNode[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY kind, name')
      .all(parentId) as NodeRow[];
    return rows.map(rowToNode);
  }

  getDescendants(parentId: string): GraphNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE parent_id = ?
           UNION
           SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id
         )
         SELECT * FROM nodes WHERE id IN (SELECT id FROM sub)`,
      )
      .all(parentId) as NodeRow[];
    return rows.map(rowToNode);
  }

  /** [root, ..., direct parent]. Empty for the root node itself. */
  getAncestors(id: string): GraphNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM nodes WHERE id = ?
           UNION ALL
           SELECT n.id, n.parent_id, up.depth + 1
             FROM nodes n JOIN up ON n.id = up.parent_id
         )
         SELECT nodes.* FROM nodes JOIN up ON nodes.id = up.id
         WHERE up.depth > 0
         ORDER BY up.depth DESC`,
      )
      .all(id) as NodeRow[];
    return rows.map(rowToNode);
  }

  /** All fine edges of the given kinds touching any of `ids` (either endpoint). */
  getEdgesTouching(ids: readonly string[], kinds: readonly EdgeKind[]): GraphEdge[] {
    if (ids.length === 0 || kinds.length === 0) return [];
    const byId = new Map<string, GraphEdge>();
    const kindList = kinds.map(() => '?').join(',');
    for (const group of chunk(ids, 200)) {
      const idList = group.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM edges WHERE kind IN (${kindList})
             AND (from_id IN (${idList}) OR to_id IN (${idList}))`,
        )
        .all(...kinds, ...group, ...group) as EdgeRow[];
      for (const r of rows) byId.set(r.id, rowToEdge(r));
    }
    return [...byId.values()];
  }

  /**
   * The graph for one canvas view: children of `parent` plus edges among them.
   *
   * Container parents (workspace/package/directory): fine `imports` edges whose
   * endpoints are both direct children, plus materialized aggregate edges.
   *
   * Symbol parents (file/class/...): call-family edges among descendants,
   * remapped to the direct children that contain their endpoints; edges that
   * leave the subtree are returned as externalEdges with the far-end node
   * resolved (these power portals).
   */
  getViewGraph(parentId: string): ViewGraph | undefined {
    const parent = this.getNode(parentId);
    if (!parent) return undefined;
    const children = this.getChildren(parentId);
    const childIds = new Set(children.map((c) => c.id));

    if (isContainerKind(parent.kind)) {
      const fine = this.getEdgesTouching([...childIds], ['imports']).filter(
        (e) => childIds.has(e.from) && childIds.has(e.to),
      );
      const aggRows = this.db
        .prepare('SELECT * FROM aggregate_edges WHERE parent_id = ?')
        .all(parentId) as AggRow[];
      return {
        parent,
        children,
        edges: [...fine, ...aggRows.map(aggRowToEdge)],
        externalEdges: [],
        externalNodes: [],
      };
    }

    // Symbol view: remap descendant-level edges onto direct children.
    const descendants = this.getDescendants(parentId);
    const parentOf = new Map<string, string | null>();
    for (const d of descendants) parentOf.set(d.id, d.parentId);

    const toChild = new Map<string, string>(); // descendant id -> containing direct child id
    for (const d of descendants) {
      let cur: string | null = d.id;
      while (cur !== null && !childIds.has(cur)) {
        cur = parentOf.get(cur) ?? null;
      }
      if (cur !== null) toChild.set(d.id, cur);
    }

    const descIds = descendants.map((d) => d.id);
    const touching = this.getEdgesTouching(descIds, SYMBOL_EDGE_KINDS);

    const internal = new Map<string, GraphEdge>();
    const external = new Map<string, GraphEdge>();
    const externalIds = new Set<string>();

    for (const e of touching) {
      const fromMapped = toChild.get(e.from);
      const toMapped = toChild.get(e.to);
      if (fromMapped !== undefined && toMapped !== undefined) {
        if (fromMapped === toMapped) continue; // collapses to a self-loop
        const id = aggregateEdgeId(parentId, e.kind, fromMapped, toMapped);
        const existing = internal.get(id);
        if (existing) existing.count += e.count;
        else internal.set(id, { id, kind: e.kind, from: fromMapped, to: toMapped, count: e.count });
      } else if (fromMapped !== undefined || toMapped !== undefined) {
        const from = fromMapped ?? e.from;
        const to = toMapped ?? e.to;
        const farEnd = fromMapped === undefined ? e.from : e.to;
        const id = aggregateEdgeId(parentId, e.kind, from, to);
        const existing = external.get(id);
        if (existing) existing.count += e.count;
        else external.set(id, { id, kind: e.kind, from, to, count: e.count });
        externalIds.add(farEnd);
      }
    }

    return {
      parent,
      children,
      edges: [...internal.values()],
      externalEdges: [...external.values()],
      externalNodes: this.getNodes([...externalIds]),
    };
  }

  /**
   * Incoming/outgoing links for one node, far ends resolved, so any node card
   * can enumerate its relationships:
   *   symbols    → call-family edges,
   *   files      → import relationships (importers in, imported files out),
   *   containers → their materialized aggregate roll-ups.
   */
  getCalls(id: string): { incoming: CallLinkRow[]; outgoing: CallLinkRow[] } {
    const kind = this.getNode(id)?.kind;
    if (kind !== undefined && isContainerKind(kind)) return this.getAggregateLinks(id);
    const kinds: readonly EdgeKind[] = kind === 'file' ? ['imports'] : SYMBOL_EDGE_KINDS;
    const kindList = kinds.map(() => '?').join(',');
    const inRows = this.db
      .prepare(`SELECT * FROM edges WHERE to_id = ? AND kind IN (${kindList})`)
      .all(id, ...kinds) as EdgeRow[];
    const outRows = this.db
      .prepare(`SELECT * FROM edges WHERE from_id = ? AND kind IN (${kindList})`)
      .all(id, ...kinds) as EdgeRow[];
    return {
      incoming: this.resolveLinks(inRows, rowToEdge, (e) => e.from_id),
      outgoing: this.resolveLinks(outRows, rowToEdge, (e) => e.to_id),
    };
  }

  /**
   * Roll-up links for a container node, from `aggregate_edges` (a container is
   * never an endpoint of a fine edge — those are file→file / symbol→symbol).
   */
  private getAggregateLinks(id: string): { incoming: CallLinkRow[]; outgoing: CallLinkRow[] } {
    const inRows = this.db
      .prepare('SELECT * FROM aggregate_edges WHERE to_id = ?')
      .all(id) as AggRow[];
    const outRows = this.db
      .prepare('SELECT * FROM aggregate_edges WHERE from_id = ?')
      .all(id) as AggRow[];
    return {
      incoming: this.resolveLinks(inRows, aggRowToEdge, (r) => r.from_id),
      outgoing: this.resolveLinks(outRows, aggRowToEdge, (r) => r.to_id),
    };
  }

  /** Map edge-like rows to CallLinkRows, resolving and dropping missing far ends. */
  private resolveLinks<R>(
    rows: readonly R[],
    toEdge: (row: R) => GraphEdge,
    farId: (row: R) => string,
  ): CallLinkRow[] {
    const out: CallLinkRow[] = [];
    for (const row of rows) {
      const node = this.getNode(farId(row));
      if (node) out.push({ edge: toEdge(row), node });
    }
    return out;
  }

  /**
   * Raw LIKE-filtered candidates for fuzzy search; the caller ranks them
   * (e.g. with fuzzysort) — SQL only prefilters.
   */
  searchCandidates(query: string, limit = 500): GraphNode[] {
    const esc = query.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE kind != 'workspace'
           AND (name LIKE '%' || ? || '%' ESCAPE '\\' OR path LIKE '%' || ? || '%' ESCAPE '\\')
         LIMIT ?`,
      )
      .all(esc, esc, limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  // ---------------------------------------------------------------- files

  getFileRecord(path: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as
      | FileRow
      | undefined;
    return row ? rowToFileRecord(row) : undefined;
  }

  listFileRecords(): FileRecord[] {
    const rows = this.db.prepare('SELECT * FROM files').all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  upsertFileRecord(record: FileRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (path, mtime_ms, size, structural_done, semantic_done)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.path,
        record.mtimeMs,
        record.size,
        record.structuralDone ? 1 : 0,
        record.semanticDone ? 1 : 0,
      );
  }

  // ---------------------------------------------------------------- aggregation

  /**
   * Rebuild `aggregate_edges` from fine `imports` edges (LCA roll-up), and
   * refresh container `symbolCount` attrs. Call after each index run.
   */
  materializeAggregates(): void {
    const nodeRows = this.db
      .prepare('SELECT id, kind, parent_id, attrs_json FROM nodes')
      .all() as Pick<NodeRow, 'id' | 'kind' | 'parent_id' | 'attrs_json'>[];
    const importRows = this.db
      .prepare(`SELECT * FROM edges WHERE kind = 'imports'`)
      .all() as EdgeRow[];

    const rows = computeAggregates(
      nodeRows.map((n) => ({ id: n.id, parentId: n.parent_id })),
      importRows.map((e) => ({
        kind: e.kind as EdgeKind,
        from: e.from_id,
        to: e.to_id,
        count: e.count,
      })),
    );

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO aggregate_edges (id, parent_id, kind, from_id, to_id, count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updateAttrs = this.db.prepare('UPDATE nodes SET attrs_json = ? WHERE id = ?');

    // Descendant counts for container sizing.
    const childrenOf = new Map<string, string[]>();
    for (const n of nodeRows) {
      if (n.parent_id === null) continue;
      const list = childrenOf.get(n.parent_id);
      if (list) list.push(n.id);
      else childrenOf.set(n.parent_id, [n.id]);
    }
    const countCache = new Map<string, number>();
    const descCount = (id: string, guard: Set<string>): number => {
      const cached = countCache.get(id);
      if (cached !== undefined) return cached;
      if (guard.has(id)) return 0;
      guard.add(id);
      let total = 0;
      for (const child of childrenOf.get(id) ?? []) {
        total += 1 + descCount(child, guard);
      }
      countCache.set(id, total);
      return total;
    };

    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM aggregate_edges').run();
      for (const r of rows) {
        insert.run(
          aggregateEdgeId(r.parentId, r.kind, r.from, r.to),
          r.parentId,
          r.kind,
          r.from,
          r.to,
          r.count,
        );
      }
      for (const n of nodeRows) {
        if (n.kind !== 'file' && !isContainerKind(n.kind as NodeKind)) continue;
        const count = descCount(n.id, new Set());
        if (count === 0 && !n.attrs_json) continue;
        const attrs = (n.attrs_json ? JSON.parse(n.attrs_json) : {}) as NodeAttrs;
        attrs.symbolCount = count;
        updateAttrs.run(JSON.stringify(attrs), n.id);
      }
    });
    run();
  }

  // ---------------------------------------------------------------- stats

  stats(): StoreStats {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c;
    return {
      nodes: count('SELECT COUNT(*) AS c FROM nodes'),
      edges: count('SELECT COUNT(*) AS c FROM edges'),
      aggregateEdges: count('SELECT COUNT(*) AS c FROM aggregate_edges'),
      files: count('SELECT COUNT(*) AS c FROM files'),
    };
  }
}
