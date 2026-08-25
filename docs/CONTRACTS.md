# CONTRACTS — binding integration decisions

Read `docs/BRIEF.md` first (product requirements). This file pins the decisions that let
packages be built independently. Do not change these interfaces without flagging it.

## Ground rules

* Node packages (`core`, `indexer`, `server`) are **ESM** (`"type": "module"`) compiled
  with `module: NodeNext` — relative imports MUST use `.js` extensions
  (`import { x } from './y.js'`). The web package uses bundler resolution (no extensions
  needed).
* Strict TypeScript; `tsconfig.base.json` sets `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` (type-only imports must be `import type`). No `any` outside LSP
  response boundaries — type those with `vscode-languageserver-protocol` types.
* All dependencies are already installed. Do NOT run `pnpm install` / `pnpm add`. If you
  are missing a dependency, note it in your final report instead.
* Verify your package with: `pnpm --filter @lsp-viz/<pkg> typecheck` (and `test` where
  tests exist). You may `pnpm --filter @lsp-viz/<pkg> build` your OWN package only.
* `@lsp-viz/core` and the indexer's public API (`packages/indexer/src/types.ts`,
  `src/index.ts`) are already built to `dist/` — compile against them; do not edit them.

## Core (`@lsp-viz/core`) — already implemented, do not modify

Read `packages/core/src/{types,api,ids,store,aggregate}.ts`. Highlights:

* `GraphNode` / `GraphEdge` / `NodeKind` / `EdgeKind` / `Range` (0-based, LSP convention),
  `ROOT_NODE_ID = 'root'`, `levelForViewParent(kind)` → 1–5.
* `nodeId(path, kind, name, containerName?)`, `edgeId(kind, from, to)`, `repoHash(absPath)`.
* `GraphStore` (better-sqlite3, synchronous): `upsertNodes`, `upsertEdges`,
  `addEdge(kind, from, to, count, sourcePath)` (accumulates weight), `deleteFileData(path)`,
  `getNode`, `getNodes`, `getNodesByPath`, `getChildren`, `getDescendants`, `getAncestors`,
  `getViewGraph(parentId)` → `{parent, children, edges, externalEdges, externalNodes}`
  (this single call powers `/api/graph` — container views get fine+aggregate imports,
  file/class views get call edges remapped to direct children plus portal edges),
  `getCalls(id)` → `{incoming, outgoing}` with far-end nodes resolved,
  `searchCandidates(q, limit)` (LIKE prefilter — rank with fuzzysort yourself),
  file records (`getFileRecord`, `listFileRecords`, `upsertFileRecord`),
  `getMeta`/`setMeta`, `materializeAggregates()`, `clearAll()`, `stats()`, `close()`.
* API response shapes for HTTP/WS live in `packages/core/src/api.ts`:
  `GraphViewResponse`, `NodeDetailResponse`, `SourceResponse`, `SearchResponse`,
  `MetaResponse`, `WsServerMessage`, `IndexRequestBody`, `IndexStats`, `IndexPhase`.
  Server returns exactly these; web consumes exactly these (web: `import type` ONLY from
  `@lsp-viz/core` — never a value import, or sqlite ends up in the bundle).

## Node identity & containment (both indexer and server rely on this)

* Containment is `GraphNode.parentId` (no `contains` rows in the edges table).
* Hierarchy: workspace root (`ROOT_NODE_ID`, path `''`) → package → directory* → file →
  symbol* (symbols nest, e.g. method inside class; `containerName` for `nodeId` is the
  enclosing symbol's name, or null for top-level symbols).
* Node ids: `nodeId(repoRelativePath, kind, name, containerName)`. For containers
  (package/directory) use their repo-relative dir path as `path`, name = last segment
  (package name for packages), containerName = null. File nodes: path = file path,
  name = basename.
* Fine edges: `imports` are file-node → file-node (structural layer, `sourcePath` = the
  importing file). `calls`/`references`/`extends`/`implements` are symbol → symbol
  (`sourcePath` = the file containing the source symbol). Every fine edge must set
  `sourcePath` so `deleteFileData` can undo it.

## Indexer (`@lsp-viz/indexer`)

Public API is frozen in `packages/indexer/src/types.ts` + `index.ts`
(`createIndexer(opts) → { run(mode), cancel(), running }`, `IndexProgressEvent`,
`LanguageAdapter`, plus export a `typescriptAdapter`). `src/indexer.ts` currently throws —
replace its internals, keep the signature.

Implementation facts (verified on this machine):

* web-tree-sitter 0.26: `import { Parser, Language, Query } from 'web-tree-sitter'`;
  `await Parser.init()`; `const lang = await Language.load(absWasmPath)`;
  `new Query(lang, src).captures(tree.rootNode)`.
* Grammars: `@vscode/tree-sitter-wasm` (NOT tree-sitter-wasms — its grammars are
  ABI-incompatible). Resolve wasm via
  `createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm')`
  (and `-tsx.wasm` for `.tsx`/`.jsx`). Verified to load and answer queries.
* LSP: spawn `typescript-language-server --stdio` (resolve the JS bin
  `typescript-language-server/lib/cli.mjs` via createRequire and spawn with
  `process.execPath` for robustness). Wrap stdio with
  `createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))`
  from `vscode-jsonrpc/node`; use request/notification types from
  `vscode-languageserver-protocol`. The initialize handshake against the fixture repo is
  verified working.
* Structural phase: workspace/package discovery (pnpm-workspace.yaml `packages` globs or
  package.json `workspaces`; fallback = repo itself as a single package). Mark entry
  files (`main`/`module`/`bin`/`exports` resolved to real files) with `attrs.entry`.
  Walk files respecting `.gitignore` (`ignore` package; root .gitignore at minimum,
  nested ones if easy) and always skipping `.git`, `node_modules`. Per file: parse with
  tree-sitter, run `importQuery`/`exportQuery`, emit file node (attrs: `loc`,
  `exportCount`, `exportedNames` capped at 5) + directory/package chain + `imports`
  edges via `adapter.resolveImport`. Workspace-package specifiers (`@demo/math`) resolve
  through the discovered package list; relative specifiers try extensions + `/index.*`;
  anything else is external → null.
* Semantic phase, per file (skip files with `semanticDone` unless mtime changed):
  `didOpen` → `documentSymbol` (map nested `DocumentSymbol[]` via
  `adapter.mapSymbolKind`; keep `range`+`selectionRange`) → for function/method/class
  symbols: `hover` at selectionRange.start for the signature (strip markdown fences →
  plain text) and `prepareCallHierarchy` + `callHierarchy/outgoingCalls` → `calls`
  edges. Resolve call targets by (targetPath, selectionRange) lookup among already-stored
  nodes; unresolved targets go to an in-memory pending list retried after all files
  complete (targets outside the repo are dropped). `didClose` when done; mark file
  record `semanticDone`. Cap in-flight requests (default 16, `concurrency` option).
* Crash recovery: if the LSP child exits mid-run, restart it, re-initialize, and resume
  with unfinished files (deterministic ids make re-processing idempotent). Give up on a
  file after 2 attempts and continue.
* Diff mode: stat all current files; changed/new (mtime or size differs) →
  `deleteFileData` + re-run both layers for those files; deleted → `deleteFileData`.
* Finish: `materializeAggregates()`, `setMeta('indexedAt', ISO)`,
  `setMeta('repoRoot', abs)`, emit `done` with stats, and console.log a stats summary
  (files, symbols, edges, per-phase duration) — performance matters.
* Tests (vitest, fixture at `fixtures/demo-repo` — resolve via
  `new URL('../../../fixtures/demo-repo', import.meta.url)`): file enumeration respects
  .gitignore; import query finds the right specifiers; structural index produces the
  expected package/dir/file nodes and cross-package aggregate edges; a full-run
  integration test (structural+semantic) asserting symbols and at least one `calls`
  edge exist (generous timeout; it spawns the real LSP server).

## Server (`@lsp-viz/server`)

* `src/cli.ts` (bin `lsp-viz`, commander): `lsp-viz <repo> [--port 4977] [--no-open]
  [--db <path>] [--reindex]`. DB default: `~/.cache/lsp-viz/<repoHash(absRepo)>.db`
  (mkdir -p). Open `GraphStore`, `createIndexer`, build Fastify, listen on
  `127.0.0.1:port`. If the store has no `indexedAt` meta (or `--reindex`) kick off
  `indexer.run('full')` in the background (log errors; don't crash the server). Open the
  browser with `open` unless `--no-open`. SIGINT → close server, cancel indexer, close
  store.
* `src/server.ts` exports `buildServer({ store, indexer, repoRoot, webDist })` →
  Fastify instance. Routes (shapes from `@lsp-viz/core` api.ts, exactly):
  * `GET /api/graph?parent=<id>` (default `root`) → `GraphViewResponse` via
    `store.getViewGraph`; 404 `{error}` when the node is unknown.
  * `GET /api/node/:id` → `NodeDetailResponse` (`getNode` + `getAncestors` + `getCalls`
    + metrics: inCount/outCount = call-link counts, childCount = children length).
  * `GET /api/source/:id` → `SourceResponse`: read `repoRoot/node.path` from disk at
    request time. Symbol nodes: whole lines of `range` (clamp to file); file nodes:
    entire file capped at 256 KB. `startLine` is 1-based.
  * `GET /api/search?q=` → fuzzysort over `store.searchCandidates(q)` with
    `keys: ['name', 'path']` (name weighted highest), limit 50 → `SearchResponse`.
  * `GET /api/meta` → `MetaResponse` (indexing = `indexer.running`).
  * `POST /api/index` body `IndexRequestBody` → 409 `{error}` if already running, else
    start `run(full ? 'full' : 'diff')` in background, reply `{ started: true }`.
  * `GET /ws` (@fastify/websocket): track sockets in a Set; forward every
    `IndexProgressEvent` as the corresponding `WsServerMessage`
    (`phase`+`progress` → `index:progress`, `done` → `index:done`,
    `error` → `index:error`). The indexer's `onProgress` is wired in the CLI or
    buildServer — your choice, but broadcasting lives in server.ts.
  * Static frontend: `@fastify/static` rooted at `webDist`
    (`new URL('../../web/dist', import.meta.url)` from `dist/server.js`), plus an SPA
    fallback: non-`/api`/`/ws` GET 404s serve `index.html`.
* Log one line on listen: URL + repo + db path; log index stats when runs complete.

## Web (`@lsp-viz/web`)

React 18 + Vite 8 + zustand 5 + @xyflow/react 12 + elkjs (in a Web Worker) + shiki.
`import type` ONLY from `@lsp-viz/core` — a value import would drag better-sqlite3 into
the browser bundle. That means `levelForViewParent` cannot be imported: re-implement that
10-line mapping in a local web helper (deliberate duplication; keep it in sync with
`core/src/types.ts`). Dev proxy in vite.config: `/api` →
`http://localhost:4977`, `/ws` → ws proxy to the same. Prod WS URL:
`(wss|ws)://${location.host}/ws`.

Follow BRIEF.md's frontend section fully. Binding specifics:

* Nav stack entries: `{ nodeId, name, kind, level, viewport: {x,y,zoom} | null,
  selectionId: string | null, showAll: boolean }`. Level via `levelForViewParent`.
  Drill-in pushes (after saving the current viewport into the current entry); Back pops
  and restores the exact viewport; breadcrumb click pops to that depth; browser
  history.pushState/popstate mirror the stack depth; Backspace = Back (never while an
  input/textarea has focus). Leaf symbols (function/method/variable/type) get the L5
  view; workspace/package/directory/file/class/interface get the canvas view.
* Data: `GET /api/graph?parent=` per view, cached per nodeId for instant Back;
  invalidate the cache and refetch the current view on `index:done` and (throttled,
  ~2 s) while `index:progress` streams. L5 uses `/api/node/:id` + `/api/source/:id`.
* Portals (file/class views): render `externalNodes` as small ghost nodes (dashed
  border, file path label) wired by `externalEdges`; double-click →
  `navigateToNode(portalTargetId)` landing on the target's PARENT view with the target
  selected and centered. `navigateToNode` (also used by search + inspector links)
  fetches `/api/node/:id`, rebuilds the stack from `ancestors`, and lands: leaf symbol →
  L5; container/file/class → its own view.
* Search palette on Cmd/Ctrl-K: debounced `/api/search`, kind icon + name + dimmed path,
  arrows/Enter/Escape.
* ELK layout in a Web Worker (`new Worker(new URL('./elk.worker.ts', import.meta.url),
  { type: 'module' })`, import `elkjs/lib/elk.bundled.js` inside the worker —
  never on the main thread). `elk.algorithm: 'layered'`; direction DOWN for levels 1–3,
  RIGHT for 4. React Flow edges: smoothstep with arrow markers.
* Visual encoding per BRIEF (kind → icon/shape, size from `attrs.symbolCount`/`loc`
  clamped, edge width from `count` (log scale), solid calls / dashed imports / dotted
  references, entry badge from `attrs.entry`, file cards show `exportCount` + top
  `exportedNames`). Muted dark palette (CSS variables), accent only for selection,
  search hits, hover neighborhood. Hover dims non-neighbors (~0.25 opacity, 150ms).
  Labels hidden below zoom ≈ 0.5. Legend (collapsible, bottom-left). View transitions
  ~200ms (fade/scale on canvas + fitView duration).
* Level-of-detail: > 50 children → keep the ~49 largest, cluster the rest into one
  "+N more" node; double-click expands (`showAll`).
* Sidebar (right panel, ALWAYS visible on canvas views; width `--sidebar-width`,
  ~440px). Two modes: with a selection (portals included) it shows SOURCE — a slim
  header (kind glyph, name, kind chip, dimmed path) over full-height Shiki source with
  real line numbers (symbol range, or the whole file for file nodes) where identifiers
  matching known outgoing callees are clickable links; ×/Escape deselects, switching to
  TREE — a collapsible directory tree from `GET /api/tree` (cached in the store,
  refetched on `index:done`) where every row navigates via `navigateToNode`, the current
  view's node is highlighted and its ancestors auto-expand. Node metadata lives IN the
  graph instead of the sidebar, and there is NO hover popover — every card
  (container/file/symbol; not portals or the cluster) carries a badge showing its
  "N in · M out" counts from the view's displayed edges (a quiet "details" toggle when
  it has none), and clicking it expands the card in place to show the extended fields
  (path, full signature clamped to 4 lines, loc/symbolCount/exports/entry) followed by
  enumerated INCOMING/OUTGOING rows from `/api/node/:id` (store-cached; ≤8 visible rows
  with inner scroll; rows navigate). The collapsed summary rows are replaced by the
  panel while open. Expansion state is a global store map (survives Back) and feeds
  `nodeDimensions`, so ELK re-layouts around the open card — keep the `node-facts`/
  `node-io` CSS geometry in sync with the `IO_*`/`FACT_*` constants in `canvas/types.ts`.
  `getCalls` backs all three: symbols → call edges, files → imports, containers →
  aggregate roll-ups.
* L5 function view: callers column | full source (Shiki, real line numbers) | callees
  column; signature header; every caller/callee navigates.
* Status bar: WS indexing progress (phase, files x/y, current file, symbol/edge counts),
  final stats when idle, and a Re-index button (POST `/api/index` `{full:false}`).
* Keyboard: arrows move selection to the spatially nearest node in that direction,
  Enter drills into the selection, Backspace back, Cmd/Ctrl-K palette, Escape closes
  palette/deselects.
* Shiki: `createHighlighter` once, langs typescript+tsx, one dark + one light theme
  (github-dark/github-light), pick via `prefers-color-scheme`; app chrome uses CSS
  variables for both schemes (dark default).
* Handle the empty states: store not yet indexed (structural phase running) and a view
  whose children are empty.

## Running end to end

```
pnpm build
node packages/server/dist/cli.js ./fixtures/demo-repo --no-open --port 4977
```

Fixture: `fixtures/demo-repo` — pnpm workspace, packages `@demo/app` (bin+main entry,
`src/main.ts` → `cli.ts` → `commands/{report,stats}.ts`) / `@demo/math`
(`arithmetic.ts`, `vector.ts` with class Vector2 + interface PointLike + type Scalar,
`stats.ts`) / `@demo/text` (`format.ts`, `slug.ts`), wired with cross-package imports
and call chains. Root tsconfig maps `@demo/*` → `packages/*/src` so the LSP resolves
cross-package calls without an install.
