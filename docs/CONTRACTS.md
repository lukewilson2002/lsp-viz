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
  (this single call powers `/api/graph`'s graph half — container views get
  fine+aggregate imports, file/class views get call edges remapped to direct children
  plus portal edges; the response's `linkCounts` are added by the server),
  `getCalls(id)` → `{incoming, outgoing}` with far-end nodes resolved,
  `getEdgesTouching(ids, kinds)` (the raw edge lookup behind `getViewGraph` and behind
  the semantic phase's calls-wins reference dedup),
  `searchCandidates(q, limit)` (LIKE prefilter — rank with fuzzysort yourself),
  file records (`getFileRecord`, `listFileRecords`, `upsertFileRecord`),
  unresolved call targets (`addPendingCalls`, `listPendingCalls`, `deletePendingCalls`),
  `getMeta`/`setMeta`, `materializeAggregates()`, `clearAll()`, `stats()`, `close()`.
  `SYMBOL_EDGE_KINDS` — `calls|references|extends|implements` — is the one list
  deciding which edges a symbol view and `getCalls` return, so a new symbol-level
  edge kind reaches every surface by being added there.
* API response shapes for HTTP/WS live in `packages/core/src/api.ts`:
  `GraphViewResponse` (incl. `linkCounts`), `LinkCounts` — the one shape for "how many
  links does this node have", shared by `GraphViewResponse.linkCounts` and
  `NodeDetailResponse.metrics` so the two can only be filled from the same set —,
  `NodeDetailResponse`, `CallLink` — a misnomer kept for compatibility: it carries
  EVERY link kind (`references`/`extends`/`implements` for symbols, `imports` for
  files, aggregate roll-ups for containers), which is why every UI that renders one
  of these lists is worded link-neutrally —, `SourceResponse`,
  `SourceLinksResponse`/`SourceLink`, `SearchResponse`,
  `TreeResponse`/`TreeNode`, `SymbolsResponse`/`SymbolFileGroup`/`SymbolEntry`,
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
* Semantic phase — TWO sweeps over the file list, in this order, sharing one language
  server, one 16-lane request pool, one crash/retry driver and one `filesDone` counter
  (`filesTotal` is the sum of both batches, so the status bar does not restart at 0).
* Sweep 1, per file (skip files with `semanticDone` unless mtime changed):
  `didOpen` → `documentSymbol` (map nested `DocumentSymbol[]` via
  `adapter.mapSymbolKind`; keep `range`+`selectionRange`) → for function/method/class
  symbols: `hover` at selectionRange.start for the signature (strip markdown fences →
  plain text) and `prepareCallHierarchy` + `callHierarchy/outgoingCalls` → `calls`
  edges. Resolve call targets by (targetPath, selectionRange) lookup among already-stored
  nodes; unresolved targets go to an in-memory pending list retried after all files
  complete (targets outside the repo are dropped). `didClose` when done; mark file
  record `semanticDone`. Cap in-flight requests (default 16, `concurrency` option).
* Between the sweeps: drain `pending_calls`. Not after — sweep 2's dedup reads the
  `edges` table, and a cross-file `calls` edge whose target file sorted later is still
  a pending row at that moment, so deduping before the drain leaves a dotted
  `references` edge painted on top of every such call arrow.
* Sweep 2, per file — `references` edges, the non-call half of "who uses this". Call
  hierarchy only ever reports CALLS, so a type annotation, an `extends` clause target,
  a default parameter value or a plain const read produced no edge at all and its
  declaration sat in the L4 view with `0 in · 0 out`. Per file: read that file's
  **file-parented** symbol nodes back out of the store (sweep 1 already asked
  `documentSymbol`; a file with no top-level declarations — a barrel — is skipped
  entirely, `didOpen` included), then `didOpen` and `textDocument/references` at each
  `selectionRange.start` with `includeDeclaration: false`. The document MUST be open:
  tsserver answers a reference request for a closed file with `[]`, which reads as
  "unused" rather than as a failure — same for a cold server, so the warm-up probe runs
  here too. `didClose` after.
  * **Direction**: `referrer --references--> referent`, matching `calls` and `imports`.
    So `padCell(value, width = DEFAULT_WIDTH)` is `padCell → DEFAULT_WIDTH`, and it is
    `DEFAULT_WIDTH` that gains an INCOMING link. Each returned `Location` maps to its
    enclosing card symbol — smallest containing symbol, then climb `parentId` while the
    parent is a symbol that is not a class/interface, so an inline callback collapses
    onto the function that owns it exactly the way call hierarchy already collapses it,
    while a method stops at the method instead of being swallowed by its class.
  * **Targets** (what gets asked) are file-parented symbols only. Function-locals would
    emit a self-loop from their own enclosing function; class/interface MEMBERS would
    turn one `new Vector2()` into both →constructor and →Vector2. Members remain valid
    SOURCES.
  * **Noise rules**, all dropping the pair: a use site outside the repo, or in a file
    with no stored nodes; no enclosing symbol at all (a bare `import { x }` specifier —
    already an `imports` edge, and `references` is symbol → symbol); `from === to`;
    either endpoint a containment ancestor of the other (recursion,
    `class Vector2 { plus(): Vector2 }`).
  * **Dedup**: `calls` wins outright. A pair already carrying a `calls` edge emits no
    `references` edge, so a dotted line is never drawn on top of a solid one. (The
    canvas repeats this check on the DISPLAY edges, because a view re-attributes a
    descendant's edge to the card containing it and can land two distinct edges on one
    pair of cards.)
  * Committed per file with `upsertEdges` (absolute), never `addEdge` (accumulating):
    this edge is produced while crawling a file that is NOT its `sourcePath`, so
    `deleteFileData` has not cleared it first and `addEdge` would double every count on
    every diff run. `sourcePath` is the SOURCE symbol's file, per the fine-edge rule
    above — not the crawled file.
  * Cost: roughly doubles the semantic phase (this repo: 3.5s → 7.0s, 88 files, 700
    reference edges). tsserver's find-all-references is a project-wide scan per symbol.
    The fixture is unaffected (~640ms either way).
* Crash recovery: if the LSP child exits mid-run, restart it, re-initialize, and resume
  with unfinished files (deterministic ids make re-processing idempotent). Give up on a
  file after 2 attempts and continue.
* Diff mode: stat all current files; changed/new (mtime or size differs) →
  `deleteFileData` + re-run both layers for those files; deleted → `deleteFileData`.
  Sweep 2's batch is WIDER than that set: the transitive `imports` closure of the
  changed files. A reference edge is produced while crawling the REFERENT's file but
  owned by the REFERRER's, so when a referrer changes, `deleteFileData` drops edges
  that only a re-sweep of its importees can recreate. (Known gap: a reference to an
  ambient/global declaration is not reachable through `imports`, so a diff run can
  leave it missing until the next full re-index. None exist in this repo.) Full mode
  sweeps every file. The reference batch never re-enters sweep 1 — call edges use
  accumulating `addEdge`, so crawling a file twice would double every call weight.
* Finish: `materializeAggregates()`, `setMeta('indexedAt', ISO)`,
  `setMeta('repoRoot', abs)`, emit `done` with stats, and console.log a stats summary
  (files, symbols, edges, call edges, reference edges, per-phase duration) —
  performance matters. `IndexProgressEvent` and `IndexStats` are frozen and carry no
  reference counter, so the reference total is reported on the console stats line only;
  the WS progress stream still reports `symbols`/`callEdges`, which therefore sit still
  while sweep 2 runs.
* Tests (vitest, fixture at `fixtures/demo-repo` — resolve via
  `new URL('../../../fixtures/demo-repo', import.meta.url)`): file enumeration respects
  .gitignore; import query finds the right specifiers; structural index produces the
  expected package/dir/file nodes and cross-package aggregate edges; a full-run
  integration test (structural+semantic) asserting symbols and at least one `calls`
  edge exist (generous timeout; it spawns the real LSP server). `references.test.ts`
  covers sweep 2: `enclosingCardSymbol` as a unit over hand-built `GraphNode[]` (no
  server), the fixture's exact five reference edges including `padCell →
  DEFAULT_WIDTH`, the whole-graph assertion that NO pair carries both a `calls` and a
  `references` edge, that no endpoint is ever a file node, that a cross-file edge is
  owned by the referrer's `sourcePath`, and the diff regression — touch the barrel
  (not `format.ts`), re-run `diff`, assert the count is still 1, which is what fails
  if `addEdge` is used instead of `upsertEdges`.

## API (`@lsp-viz/server`, `src/api.ts`)

`createApi({ store, indexer, repoRoot })` → `LspVizApi`. This is where every answer is
computed; it imports nothing about HTTP, Electron, or IPC. Two hosts call it — the
Fastify routes below and the desktop app's worker — and **neither may hold logic**: a
rule that lives in one transport is a rule the other one gets wrong.

* One method per route, named in `core`'s `ApiRouteName` so both transports name the
  same calls: `graph`, `nodeDetail`, `source`, `links`, `search`, `symbols`, `tree`,
  `meta`, `startIndex`. All synchronous except `source` (reads the file at call time).
* Failures throw `ApiRouteError(status, message)` carrying the status this document
  specifies. The HTTP host maps it to a reply code; the IPC host puts it in the reply
  envelope. Both surface it to the browser as the same `ApiError`.
* `subscribe(listener)` / `publish(event)` fan index progress out; `startIndexRun(mode)`
  runs the indexer in the background, catching sync AND async failures and publishing
  them as `index:error` (a throwing indexer never takes the host down).
* `nodeLinks` and `sourceLinks` live here for the reasons given in the module docstring,
  and are the single definition of their respective questions.

## Server (`@lsp-viz/server`)

The HTTP/WS transport, plus the CLI. `src/server.ts` is deliberately thin: unpack params,
call one API method, map `ApiRouteError` to its status.

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
    `store.getViewGraph`, plus `linkCounts`: `nodeLinks` counted for every child,
    so a card can headline its link totals without a request per card; 404
    `{error}` when the node is unknown.
  * `GET /api/node/:id` → `NodeDetailResponse` (`getNode` + `getAncestors` +
    `nodeLinks` + metrics: inCount/outCount = the lengths of those two lists,
    childCount = children length).
  * `nodeLinks(store, node)` (server.ts) is the ONE definition of "this node's
    links", feeding both routes above so a summary can never disagree with the
    list it summarises. It is `store.getCalls` for every node whose edges are
    recorded on it (containers → aggregate roll-ups, files → imports, leaf
    symbols → calls); for a symbol that CONTAINS declarations — a class, an
    interface — it rolls the subtree up the way `getViewGraph` already rolls
    edges onto the card that draws them: every link whose far end is outside
    the subtree, merged per (kind, far node) with weights summed, the node's own
    edges (`extends`) included. Without that, a class card headlines the arrows
    the canvas draws out of it and then expands to "no links".
  * `GET /api/source/:id` → `SourceResponse`: read `repoRoot/node.path` from disk at
    request time. Symbol nodes: whole lines of `range` (clamp to file), **extended
    upward over the declaration's leading comment block** so the JSDoc a reader wants
    is part of the slice — `src/comments.ts` `scanLeadingComments` does that scan
    against a language-neutral marker table (never a parse), stops at a blank line,
    at real code, at the previous sibling declaration's last line, and after
    `MAX_DOC_LINES`. File nodes: entire file capped at 256 KB. `startLine` is 1-based
    and reflects the extended start.
  * `GET /api/links/:id` → `SourceLinksResponse`: which identifiers the node's source
    slice is allowed to turn into links. Resolved HERE, not in the browser, for two
    reasons — the client would need 1 + N (+ a barrel hop) requests per selection to
    learn the same thing, and ambiguity has to be judged against the whole store rather
    than against one response. Three tiers, higher wins outright:
    **P1** the node's own `nodeLinks(...).outgoing` filtered to
    `calls|references|extends|implements` with a symbol-kind far end — what the LSP
    actually bound, and the tier the `references` edges above feed;
    **P2** the link file's own depth-0 declarations;
    **P3** depth-0 declarations of each file it imports, plus ONE hop through a
    directly-imported file that declares nothing itself (that is what a barrel looks
    like in the graph — the fixture's `packages/*/src/index.ts` are exactly this).
    Depth-0 everywhere: a function-local `rows` or `width` is never a candidate.
    Within a tier a name is dropped outright the moment a SECOND DISTINCT node id
    claims it — ids compared, never occurrence counts, so P1 legitimately yielding one
    far node under two edge kinds does not poison it — because a link that jumps to the
    wrong symbol is worse than no link and the only undo is Back. Names failing
    `/^[A-Za-z_$][A-Za-z0-9_$]*$/` are dropped, which is what keeps a file's `imports`
    far ends (`index.ts`) out. `links` is therefore UNIQUE BY NAME, so the client's
    first-wins lookup is safe. `[]` for a container (no file behind it). 404 `{error}`
    when the node is unknown.
  * `GET /api/symbols/:id` → `SymbolsResponse`: the declarations in or under a node,
    grouped by declaring file, each group's `symbols` flat and in source order with
    nesting expressed as `depth`. Scope is derived from the node's KIND, never from a
    query param — container → `'descendants'`, file → `'file'`, symbol →
    `'members'` — so one id always answers the same question. Groups sorted by `path`,
    empty groups dropped, capped at `MAX_GROUPS` files / `MAX_SYMBOLS` entries with
    `omitted` + `truncated` reporting the loss; `totalFiles`/`totalSymbols` are the
    pre-cap counts. 404 `{error}` when the node is unknown.
  * `GET /api/tree` → `TreeResponse`: the containment skeleton (containers + files
    only, no symbols) as one nested `TreeNode` rooted at `ROOT_NODE_ID`; siblings
    sorted directories-before-files then by name; containers always carry a
    `children` array (empty when childless), files never do. 404 `{error}` before the
    first index run.
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
* Tests (vitest, `packages/server/test`, `"test": "vitest run"`): the fixture repo
  contains no comments, so the `/api/source` doc-comment scan is covered by unit tests
  over `scanLeadingComments` — each documented heuristic (blank-line stop, code stop,
  sibling floor, marker false-positives like `#count` / `--i`, trailing block comments,
  the line cap) gets a case. `links.test.ts` pins `nodeLinks`' subtree roll-up (a class
  card headlining arrows it then expands to nothing is the failure). `sourceLinks.test.ts`
  drives `/api/links/:id` through `app.inject` over a hand-built store: the barrel hop,
  the depth-0 filter, ambiguity poisoning, tier precedence, the identifier gate, 404.

## Web (`@lsp-viz/web`)

React 18 + Vite 8 + zustand 5 + @xyflow/react 12 + elkjs (in a Web Worker) + shiki.
`import type` ONLY from `@lsp-viz/core` — a value import would drag better-sqlite3 into
the browser bundle. That means core's small VALUE exports cannot be imported:
`src/levels.ts` re-implements them (`ROOT_NODE_ID`, `levelForViewParent`,
`isLeafSymbolKind`, `isContainerKind`, `isDrillableKind`) — deliberate duplication, keep
it in sync with `core/src/types.ts`.

**Transport.** Nothing above `src/api/client.ts` knows which host it is running in.
`client.ts` keeps its function signatures (`fetchGraph`, `fetchNodeDetail`, …) and
delegates to the `Transport` chosen once in `src/api/transport.ts`:

* `httpTransport` — fetch + WebSocket, for the CLI host. Route→URL mapping lives there
  and nowhere else. Dev proxy in vite.config: `/api` → `http://localhost:4977`, `/ws` →
  ws proxy to the same. Prod WS URL: `(wss|ws)://${location.host}/ws`.
* `ipcTransport` — Electron, selected by feature-detecting `window.lspviz` (the preload
  bridge). **Never** by a build flag: one Vite bundle serves both hosts, and
  `packages/web/dist` is copied verbatim into the desktop app.

`desktopPlatform()` stamps `data-desktop="<platform>"` on `<html>` in `main.tsx`; the
only CSS keyed off it clears the macOS traffic lights and marks the breadcrumb as the
window's drag region.

Follow BRIEF.md's frontend section fully. Binding specifics:

* Nav stack entries: `{ nodeId, name, kind, level, viewport: {x,y,zoom} | null,
  selectionId: string | null, showAll: boolean, showPortals: boolean }`. Level via
  `levelForViewParent`. The two `show*` flags are separate LOD overrides — children and
  ghosts answer different questions, so expanding one must not expand the other.
  Drill-in pushes (after saving the current viewport into the current entry); Back pops
  and restores the exact viewport; breadcrumb click pops to that depth; browser
  history.pushState/popstate mirror the stack depth; Backspace = Back (never while an
  input/textarea has focus). Leaf symbols (function/method/variable/type) get the L5
  view; workspace/package/directory/file/class/interface get the canvas view.
* Data: `GET /api/graph?parent=` per view, cached per nodeId for instant Back;
  invalidate the cache and refetch the current view on `index:done` and (throttled,
  ~2 s) while `index:progress` streams. L5 uses `/api/node/:id` + `/api/source/:id`.
* Portals (file/class views): render `externalNodes` as small ghost nodes (dashed
  border, `basename:line-line` location label via `cardModel.formatCardPath`) wired by
  `externalEdges` — deliberately kept a two-row ghost while real cards grew a full row
  stack, since a portal is a POINTER to a declaration elsewhere; double-click →
  `navigateToNode(portalTargetId)` landing on the target's PARENT view with the target
  selected and centered.
* Ghosts give way before content, in two steps. `rollUpPortals` merges the ones sharing
  a parent declaration; past `PORTAL_MAX_VISIBLE` the REST collapse wholesale into one
  `portalCluster` node reading "N external symbols" (N counts symbols, so a roll-up
  ghost contributes its whole group), with every edge re-targeted onto it and
  double-click → `setShowPortals()`. Both steps exist because ghosts and cards share
  one `LOD_MAX_VISIBLE` budget: a file with forty external callers otherwise spends its
  entire budget on its surroundings and pushes its OWN declarations into "+N more".
  The node a navigation landed on is never collapsed — the canvas has to centre it. `navigateToNode` (also used by search + sidebar links)
  fetches `/api/node/:id`, rebuilds the stack from `ancestors`, and lands: leaf symbol →
  L5; container/file/class → its own view.
* Search palette on Cmd/Ctrl-K: debounced `/api/search`, kind icon + name + dimmed path,
  arrows/Enter/Escape.
* ELK layout in a Web Worker (`new Worker(new URL('./elk.worker.ts', import.meta.url),
  { type: 'module' })`, import `elkjs/lib/elk.bundled.js` inside the worker —
  never on the main thread). `elk.algorithm: 'layered'`; direction DOWN for levels 1–3,
  RIGHT for 4.
* Edges render ELK's own routes. `elk.edgeRouting: 'ORTHOGONAL'` already computes an
  obstacle-avoiding polyline per edge — that is what `elk.spacing.edgeNode` reserves the
  channels for — so the worker returns `edges[].sections` as `LayoutResponse.routes`
  (`LayoutRoute { id, points }`, same coordinate space as `positions`), and the single
  `routed` React Flow edge type draws it with 5px rounded corners. Endpoints are snapped
  to the handles React Flow rendered; ELK's interior bends are kept verbatim.
  `elk.layered.mergeEdges` stays on — merged edges leave from a node's border CENTRE,
  which is exactly where `NodeHandles` puts its one handle per side, so the snap is
  normally a no-op. An edge with no usable route (ELK failed, or no sections came back)
  falls back to `getSmoothStepPath`, so no edge is ever left undrawn. Arrow markers
  unchanged. Reading the routes back is free: they were computed and discarded before.
* Visual encoding per BRIEF (kind → icon/shape, edge width from `count` (log scale),
  solid calls / dashed imports / dotted references, entry badge from `attrs.entry`,
  file cards show `exportCount` + top `exportedNames`). A PORTAL edge is ghosted by its
  class but keeps its KIND's dash (`EDGE_DASH[kind] ?? '4 4'`), or every cross-file
  reference would draw as a call. And `buildViewModel` drops a display `references` edge
  when a `calls` edge shares the same `(portal, from, to)`: the indexer already
  guarantees no PAIR carries both, but a view re-attributes a descendant's edge to the
  card containing it, so two edges the indexer knows are distinct can still land on one
  pair of cards — and the call is the stronger statement.
  BRIEF's size-encodes-weight
  rule (`attrs.symbolCount`/`loc`, clamped) applies to card WIDTH only — height is
  derived from the rows the card actually renders, since scaling a content-derived
  height would clip it. Muted dark palette (CSS variables), accent only for selection,
  search hits, hover neighborhood. Hover dims non-neighbors (~0.25 opacity, 150ms) —
  but ONLY when the hovered node has neighbors to reveal. Dimming answers "which of
  these does it touch"; on an unconnected node there is no answer, so it would darken
  the whole view to restate the card's own "0 in · 0 out" row while hiding everything
  else.
  Legend (collapsible, bottom-left). View transitions ~200ms (fade/scale on canvas +
  fitView duration).
* Level-of-detail: > 50 RENDERED NODES (ghosts included) → keep the largest children,
  cluster the rest into one "+N more" node; double-click expands (`showAll`). Ghosts are
  collapsed first, so the budget is spent on the view's own contents (see Portals).
  Either expansion re-fits the camera even when the user has panned — a same-view
  rebuild normally must NOT move a camera the user has taken, but an expansion
  re-lays-out the graph around a much larger node set and leaving the camera put is how
  a double-click ends with the graph off screen.
* Card height estimates (`canvas/types.ts`) must round UP against what the browser will
  do; `.node-card` is `overflow: hidden` at a height it does not control, and the flex
  column absorbs any shortfall out of the one shrinkable row (the signature), which
  reads as a clipped last line on a card that otherwise measures correctly. Two things
  that costs in practice: the card's own 1px border counts (`box-sizing: border-box` is
  global, so React Flow's height INCLUDES it), and wrapped text does not pack to the
  right edge — `length / charsPerLine` under-counts real word wrapping, so
  `wrappedLineCount` walks the words the way the browser does.
* Sidebar (right panel, ALWAYS visible on canvas views; width `--sidebar-width`,
  ~440px, drag-to-resize on its left edge, double-click resets). TWO TABS, both panes
  kept mounted so switching never drops tree expansion, scroll position or a Shiki
  render:
  * **Files** — always present. The containment tree from `GET /api/tree` (cached in
    the store, refetched on `index:done`); every row navigates via `navigateToNode`,
    EXCEPT a directory row that is already the current view or the selection — there,
    navigating again would push a duplicate history entry and change nothing on
    screen, so the click toggles the row open/closed instead.
    Two distinct marks: the CURRENT VIEW row is quiet (elevated background + left
    rail), the SELECTION row is accent-tinted. A selection with no tree row of its own
    (a symbol, a class L4 view, a portal target) anchors to its nearest tree-present
    ancestor via `chrome/treeAnchor.ts`, which flags the row as a PROXY and hangs a
    chip naming the real target on it — so `index.ts` never merely looks selected when
    a function inside it is. Both anchor chains auto-expand; never auto-collapse.
    The disclosure control is drawn (`DisclosureChevron`), not a character: U+25B8 /
    U+25BE are Unicode's SMALL triangles and stay a speck at any font-size a 25px row
    can afford. One shape, rotated for the open state.
  * **Details** — exists only while something is selected (portals included; the
    "+N more" cluster is excluded, derived in `Sidebar.tsx` so the store never has to
    know about canvas internals). Labelled with the selected node's own name and
    carrying a × that deselects. Contents, in one scrollable column: a sticky identity
    header (kind glyph, name, kind chip, path, metrics line, full unclamped signature,
    "Open ↗" → `navigateToNode`), then collapsible sections — SOURCE (`/api/source/:id`
    through Shiki with real line numbers, identifiers the graph can resolve clickable,
    skipped for containers which have no file), SYMBOLS/DECLARATIONS/MEMBERS
    (`/api/symbols/:id`, indented by `depth`, file group headers only for container
    scopes, every row navigates), then INCOMING and OUTGOING (`/api/node/:id`,
    complete lists). This pane is the UNCAPPED surface: nothing here is clamped,
    hover-gated or cut off at N rows.
  * Tab state: `select(id)` opens Details, `select(null)` falls back to Files; the
    rendered tab is re-derived from the live selection each render, so popstate
    rebuilds, Escape and cluster pseudo-selections need no special case. `sidebarTab`
    and `detailCollapsed` (keyed by SECTION, not node id) are global store fields that
    survive Back/forward and `invalidate()` — they are preferences, not indexed data.
  * Cache invalidation: `invalidate()` empties the id-keyed caches and bumps
    `dataEpoch`. An effect that fetches into one of them keyed only on a node id would
    never re-run afterwards and would spin forever (the Details pane reads three of
    them at once, and a failed fetch caches nothing to watch), so `dataEpoch` belongs
    in the deps of every such effect.
* Node cards: metadata lives IN the graph, not behind an interaction. There is NO hover
  popover and NO details toggle — every card (container/file/symbol; not portals or the
  cluster) renders its full row stack unconditionally: glyph + name (wrapping to 2
  lines) + `entry` pill, signature (symbols; real highlighted, clickable code via
  `CodeSignature`, clamped to `SIG_MAX_LINES`), display path (`basename:start-end` for
  symbols), a facts line for containers and files only (kind · `symbolCount` items /
  `loc` / `exportCount` — symbols have none, since the glyph carries the kind and the
  path row's line range carries the `loc`), top `exportedNames`
  (files), and last a LINKS ROW reading "N in · M out" from
  `GraphViewResponse.linkCounts` — the NODE's own links, never a count of the arrows
  this view happens to draw (a view merges parallel edges, re-attributes a descendant's
  edges to the card containing it, and hides whatever the LOD cluster swallowed).
  `canvas/cardModel.ts` is the single source of truth for WHICH rows exist and for the
  path/exports strings; `NodeCard` renders exactly that `CardRows`, and
  `canvas/types.ts` measures exactly that `CardRows` — so "rendered but not measured"
  is unrepresentable. Clicking the links row expands the card in place with enumerated
  INCOMING/OUTGOING rows from `/api/node/:id` (store-cached; ≤`IO_MAX_ROWS` visible with
  inner scroll; rows navigate) — the SAME links the row counted, since the server
  derives both from `nodeLinks`, so "8 out" can never expand to an empty list. It stays
  clickable at "0 in · 0 out": the panel saying so outright is the answer to "does this
  really connect to nothing?". Expansion state is a global store map (survives Back) and feeds `nodeDimensions`, so ELK re-layouts around
  the open card — the `.node-card*` / `.node-io*` CSS geometry MUST stay in sync with
  the constants in `canvas/types.ts` (each names the rule it mirrors; the card is
  `overflow: hidden` at an ELK-fixed height, so under-reserving clips a row).
  `nodeLinks` backs every kind: symbols → call edges, a class/interface → its members'
  calls rolled up, files → imports, containers → aggregate roll-ups.
* Zoom level-of-detail is two-tier and opacity-only (heights are ELK-fixed): below
  ≈0.34 the secondary rows fade out, below ≈0.2 the glyph and name go too.
* L5 function view: "Used by" column | full source (Shiki, real line numbers) | "Uses"
  column; signature header; every row navigates. The three columns are a grid of
  `minmax(0, …fr)` tracks separated by two drag handles, defaulting to near-equal thirds
  with a nudge to the source column and persisted per browser (`views/columnWidths.ts`).
  `minmax(0, …)` is load-bearing, not cosmetic: a grid track's automatic minimum is its
  min-content width, so one long symbol name in a link column used to set a floor that
  squeezed the source column — the thing the page exists to show — down to a scrollbar.
  For the same reason `.call-path` is `flex: 1 1 0` and takes NO part in the row's
  overflow: the path gives way entirely before a symbol name loses one character.
  NOT "Callers"/"Callees": both lists
  carry every symbol-level edge kind, and this view is reached by variables and types
  too — a constant is REFERENCED by the function whose default parameter reads it, and
  that is the node most likely to be looked at here. `chrome/CallList.tsx` renders both
  columns and the sidebar's INCOMING/OUTGOING, so its `empty` strings are written in
  the same link-neutral language.
* Clickable identifiers in code (EVERY surface — the two source views and the three
  signature blocks): one pass, `code/linkify.ts`, over each surface's own detached DOM;
  the candidate list comes from
  `GET /api/links/:id` through the one hook `code/useCodeLinks.ts` — never rebuilt from
  `detail.outgoing` per surface, which is how a FILE node ended up offering only
  basenames like `index.ts` and no file source view ever had a single link. The client
  decides only WHERE in the text a name is really an identifier, and gets three things
  right that a naive `\b(name)\b` does not: (1) text inside a string or a comment is
  skipped — `highlight.ts` runs Shiki with `includeExplanation: 'scopeName'` and a span
  transformer stamping `data-tok="skip"` on tokens whose INNERMOST scope is
  string/comment, innermost because a template substitution `${formatTable(rows)}`
  carries the enclosing `string.template.ts` in its stack and testing the whole stack
  would drop every identifier inside `${...}`; (2) boundaries are hand-written
  `(?<![A-Za-z0-9_$])` / `(?![A-Za-z0-9_$])`, since `\b` is `\w`-based and `\w` excludes
  `$` — which both hides `$store` entirely and matches `mean` inside `mean$raw`;
  (3) a member access is not a link — `values.length` names a property of `values`, and
  the preceding two characters are carried ACROSS text nodes because Shiki puts the `.`
  in a token span of its own (two characters, not one, so `...NODES` still links).
  The pass runs on a detached `DOMParser` document, never on live nodes React owns.
* Signature blocks (`code/CodeSignature.tsx`) are code, not captions: Shiki-highlighted
  and linkified by the same two modules as a source view, on node cards, in the sidebar
  Details tab and in the L5 header. Highlighting is best-effort — until the Shiki chunk
  loads, and forever for a language with no grammar, the plain text renders WITH its
  links, because linking is a graph fact and does not depend on a grammar. A card
  fetches its `/api/links/:id` on FIRST HOVER, not with the view: a view holds dozens of
  cards, hovering one is the move that precedes clicking inside it, and the store
  de-dupes and caches the answer. Snippets are memoized across component lifetimes
  (`useHighlightedCode`) because React Flow rebuilds every card on each layout.
* Status bar: WS indexing progress (phase, files x/y, current file, symbol/edge counts),
  final stats when idle, and a Re-index button (POST `/api/index` `{full:false}`).
* Keyboard: arrows move selection to the spatially nearest node in that direction,
  Enter drills into the selection, Backspace back, Cmd/Ctrl-K palette, Escape closes
  palette/deselects. The canvas keys (arrows/Enter) additionally stand down while focus
  is inside `.sidebar` — its rows and section headers own those keys — but Backspace
  (owned by the breadcrumb) and Escape keep working everywhere outside an input.
* Shiki: `createHighlighter` once, langs typescript+tsx, one dark + one light theme
  (github-dark/github-light), pick via `prefers-color-scheme`; app chrome uses CSS
  variables for both schemes (dark default).
* Handle the empty states: store not yet indexed (structural phase running) and a view
  whose children are empty.

## Desktop (`@lsp-viz/desktop`)

Electron 39. One open repo = one `BrowserWindow` + one `utilityProcess`, paired for life
by `RepoSession` (`src/session.ts`); a call arrives tagged with its WebContents, which
maps to exactly one session, so multiple repos need no routing.

* **Worker** (`src/worker.ts`) holds `GraphStore` + `Indexer` + `createApi` — the same
  triple `cli.ts` builds, with IPC where the CLI puts Fastify. All three live together so
  there is exactly one SQLite connection per repo. It runs out of the main process
  because indexing would otherwise jank the window it is supposed to leave usable.
  DB path matches the CLI's (`~/.cache/lsp-viz/<repoHash>.db`) so the two share a cache.
* **`ELECTRON_RUN_AS_NODE=1`** is set in the worker before the indexer is created. The
  adapter spawns `process.execPath <tsserver-cli> --stdio`, and in Electron that is the
  app binary; the flag is what makes it re-execute as plain Node instead of booting a
  second copy of the app. `spawn` inherits the env, so restarts are covered too.
* **Renderer** is `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
  Everything it can do is the three channels in `src/preload.cts`. A sandboxed preload is
  CJS and has **no filesystem `require`** — it cannot import `ipc.cts` at runtime, so the
  channel names are repeated there and pinned by type (`typeof import('./ipc.cjs')`,
  erased before emit). Changing one file without the other fails the build.
* **`app://bundle/index.html`**, a privileged standard scheme (`src/protocol.ts`), serves
  `packages/web/dist` with a traversal guard, SPA fallback, and the app's CSP. Not
  `file://` (null origin breaks the ELK module worker) and not localhost HTTP (any local
  process could read the graph).
* Reply envelope: `{ok: true, value}` / `{ok: false, status, error}` — errors ride back as
  values because an Error thrown in `ipcMain.handle` reaches the renderer with its status
  stripped and "Error invoking remote method" prepended.

## Running end to end

```
pnpm build

# desktop
pnpm desktop -- --repo ./fixtures/demo-repo
cd packages/desktop && npx electron scripts/smoke.mjs --repo ../../fixtures/demo-repo \
  --out /tmp/shot.png     # boots the real main process, reports console/preload/render
                          # failures and what the page actually rendered

# CLI
node packages/server/dist/cli.js ./fixtures/demo-repo --no-open --port 4977
```

Fixture: `fixtures/demo-repo` — pnpm workspace, packages `@demo/app` (bin+main entry,
`src/main.ts` → `cli.ts` → `commands/{report,stats}.ts`) / `@demo/math`
(`arithmetic.ts`, `vector.ts` with class Vector2 + interface PointLike + type Scalar,
`stats.ts`) / `@demo/text` (`format.ts`, `slug.ts`), wired with cross-package imports
and call chains. Root tsconfig maps `@demo/*` → `packages/*/src` so the LSP resolves
cross-package calls without an install.
