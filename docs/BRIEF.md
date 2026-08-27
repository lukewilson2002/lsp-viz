# lsp-viz — product brief (source of truth)

A desktop app that lets a developer explore an entire codebase visually, without reading
source files linearly. Point it at a repo, it analyzes the code via the Language Server
Protocol, and renders an interactive, infinitely-nestable graph you can drill into and back
out of — modeled on C4 diagram theory (zoom levels with consistent abstraction per level).

TypeScript repos are the v1 target, but nothing in the core data model or frontend may be
TypeScript-specific. All semantic analysis flows through LSP so future languages (Go, Rust,
C++, Python) are added by registering a new language server, not by writing new analysis code.

## Product principle

The user should be able to answer "what does this codebase do, and how?" without opening a
file. Source code is the leaf of the navigation tree, not the starting point. Every view
answers one question at one level of abstraction, and drilling down answers the
next-more-specific question. Hitting Back always returns to the exact prior view (scroll,
zoom, selection preserved).

## Abstraction levels (C4-inspired)

Each diagram level has ONE consistent abstraction; never mix levels in a single view.

1. **L1 — Workspace** (C4 "System Context"): the repo as a whole. Nodes are top-level
   packages/workspaces (from package.json workspaces / pnpm-workspace.yaml; fall back to
   top-level src directories). Edges are aggregate dependency relationships (package A
   imports from package B, weighted by import count).
2. **L2 — Package** (C4 "Container"): inside one package. Nodes are directories/feature
   areas. Edges are aggregated imports between them. Entry points (main, exports, bin)
   visually marked.
3. **L3 — Module** (C4 "Component"): inside one directory. Nodes are files. Edges are
   file-level imports. Each file node shows a summary: exported symbols count, top exported
   names.
4. **L4 — File** (C4 "Code"): inside one file. Nodes are declarations — functions, classes,
   interfaces, types, top-level consts (from LSP `documentSymbol`). Edges are call/reference
   relationships between them (from call hierarchy), plus dashed edges to symbols in other
   files, rendered as portal nodes you can click to jump.
5. **L5 — Function**: the leaf. A focused view of one function: syntax-highlighted source,
   signature, incoming callers, outgoing callees (each clickable). Clicking a callee
   navigates to that function's L5 view and pushes history.

**Aggregation rule:** an edge at level N is the roll-up of edges at level N+1. Compute
fine-grained edges once, aggregate upward — never analyze separately per level.

## Architecture

Monorepo, pnpm workspaces, TypeScript throughout, strict mode.

```
packages/
  core/        # graph IR types + graph store (SQLite via better-sqlite3)
  indexer/     # LSP client, crawler, tree-sitter import extraction
  server/      # the API (api.ts) + its Fastify HTTP/WebSocket transport, CLI entry
  desktop/     # Electron shell — the primary way to run it
  web/         # React + Vite frontend
```

The app is desktop-first: `pnpm desktop` opens a window with no server, port, or browser
involved. The CLI host remains for remote use (SSH, a container), and both drive the same
`createApi()` — the API is defined once and transport-free, so neither host can drift from
the other. The frontend picks its transport at runtime by feature-detecting the Electron
preload bridge, so there is exactly one Vite bundle.

SQLite: `nodes`, `edges`, plus an `aggregate_edges` table materialized after indexing for
L1–L3 roll-ups, and a `meta` table with index timestamp and repo root. Symbol IDs must be
deterministic across re-index runs when code hasn't moved (stable hash of
(path, kind, name, containerName)).

## Indexer

Two extraction layers, both language-pluggable behind a `LanguageAdapter` interface
(server command, file extensions, tree-sitter grammar, import query). Ship one adapter:
`typescript`. The crawler must contain zero TS-specific logic outside the adapter.

**A. Structural layer — tree-sitter** (`web-tree-sitter` WASM, TypeScript/TSX grammars):
enumerate source files (respect .gitignore; use the `ignore` package), extract
import/export statements per file (a tree-sitter query, not regex), extract exact function
body ranges. Builds L1–L3 (containment + import graph) entirely — fast, runs first so the
user gets a navigable module view within seconds.

**B. Semantic layer — LSP**: spawn `typescript-language-server --stdio` as a child process.
Use `vscode-jsonrpc` / `vscode-languageserver-protocol` for the client — do not hand-roll
JSON-RPC framing. Flow:

1. `initialize` with repo root as workspace folder; wait for server ready (send a no-op
   request and await it; some servers need warm-up).
2. Per source file: `textDocument/didOpen`, then `textDocument/documentSymbol` → L4 nodes.
3. Per function/method symbol: `textDocument/prepareCallHierarchy` at the symbol's
   selection range, then `callHierarchy/outgoingCalls` → `calls` edges. Resolve targets to
   node IDs by (uri, range) lookup; if the target file isn't indexed yet, create a
   placeholder and reconcile later.
4. `textDocument/hover` at each function symbol → signature string (strip markdown fences;
   store plain text).
5. Pipeline requests but cap in-flight (~16). `didClose` after processing to bound server
   memory.

Indexing is a background job with progress events streamed over WebSocket. UI usable as
soon as the structural layer finishes; call edges appear progressively. Persist to SQLite
so re-opening on the same repo is instant; "Re-index" diffs by file mtime and re-crawls
only changed files. The indexer must survive LSP server crashes: detect exit, restart,
resume from last completed file. Log indexing stats (files, symbols, edges, duration).

## Server (Fastify)

* `GET /api/graph?parent=<nodeId>&level=<n>` — children of a node + edges among them
  (powers every canvas view; L1 is parent=root)
* `GET /api/node/<id>` — full node detail incl. incoming/outgoing call edges
* `GET /api/source/<id>` — source text for a symbol node's range (read from disk at request
  time; don't store source in the DB)
* `GET /api/search?q=` — fuzzy symbol search across nodes (name + path)
* `POST /api/index` — start/re-run indexing; progress via WebSocket `/ws`
* Serve the built frontend statically.
* CLI entry: `lsp-viz <path-to-repo>` opens the browser.

## Frontend (React 18 + Vite + TS; Zustand; React Flow; elkjs in a Web Worker; Shiki)

**Navigation model — the core of the app**

* Navigation stack of views; each entry `{ nodeId, level, viewport, selection }`. Drill-in
  (double-click) pushes; Back (button, Backspace, browser back) pops and restores viewport
  exactly. Breadcrumb bar shows the stack, every crumb clickable.
* Double-click = drill in. Single-click = select → inspector panel (right): name, kind,
  signature, path, metrics (in/out edge counts), and for symbol nodes a syntax-highlighted
  source preview (Shiki) with line numbers matching the real file.
* In the inspector source view, identifiers corresponding to known graph nodes (callees
  resolved during indexing) are clickable links that navigate to that symbol's view.
* Portal nodes at L4: calls to symbols outside the current file render as small ghost nodes
  labeled with their file. Double-clicking a portal jumps to that file's L4 view with the
  target symbol selected and centered. Ghosts are context, not content: when there are too
  many to be worth drawing they collapse into a single "N external symbols" node that
  expands on double-click, so a heavily-used file's view stays about the file.
* Search (Cmd/Ctrl-K): fuzzy palette over all symbols; selecting one jumps to its view at
  the right level and pushes the full ancestor chain onto the breadcrumb.

**Diagramming craft (don't ship a hairball)**

* Layered (Sugiyama) ELK layout; left-to-right for call flow, top-to-bottom for containment
  views. Orthogonal or smooth-step edge routing; never straight-line spaghetti.
* Visual encoding: node shape/icon = kind; node size = symbol count (containers) or LOC
  (files); edge thickness = aggregated count; edge style = kind (solid calls, dashed
  imports, dotted references). Legend component always available.
* Level-of-detail: cap visible nodes per view (~50); cluster smallest into an expandable
  "+N more" group node. Labels hide below a zoom threshold.
* Muted base palette; color reserved for selection, search hits, and hovered node's direct
  neighbors (dim everything else on hover — highest-value interaction, do it well).
* Every view transition animated (~200ms).

## Quality bar

* Strict TypeScript everywhere; no `any` outside LSP response boundaries.
* Vitest for core + indexer (IR aggregation logic; import query against fixture repos —
  a small fixture monorepo lives in `fixtures/demo-repo`).
* README with demo flow: `pnpm install && pnpm build && pnpm lsp-viz ./fixtures/demo-repo`.
* Keyboard nav: arrows move selection, Enter drills, Backspace goes back, Cmd/Ctrl-K search.
