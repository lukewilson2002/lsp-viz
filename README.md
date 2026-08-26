# lsp-viz

**Explore a codebase visually — without reading files linearly.**

Point lsp-viz at a repo and it builds an interactive, infinitely-nestable graph of the
code, modeled on [C4 diagram](https://c4model.com/) zoom levels: every view answers one
question at one level of abstraction, and drilling down answers the next-more-specific
one. Source code is the *leaf* of the navigation tree, not the starting point.

Semantic analysis flows through the Language Server Protocol, so new languages are added
by registering a language server — not by writing new analysis code. TypeScript ships as
the v1 adapter.

## Demo

```bash
pnpm install && pnpm build && pnpm desktop
```

That launches the desktop app; pick a repo from the open dialog (or pass one:
`pnpm desktop -- --repo ./fixtures/demo-repo`). It indexes and opens in a window —
no server, no port, no browser tab.

The same build also ships as a CLI that serves the UI over HTTP, which is handy over SSH:

```bash
pnpm lsp-viz /path/to/your/repo
```

Both share one index cache in `~/.cache/lsp-viz/`, so a repo crawled by either opens
instantly in the other.

Demo flow, 60 seconds:

1. **L1 — Workspace.** The repo's packages, edges weighted by import count.
2. **Double-click a package → L2.** Its directories, entry points badged.
3. **Drill again → L3.** Files, with export summaries, wired by imports.
4. **Drill into a file → L4.** Its declarations wired by how they actually use each
   other: solid *call* edges and dotted *reference* edges — a type annotation, an
   `extends` target or a constant read in a default parameter draws an arrow too, so a
   declaration nothing calls is not stranded. Links that leave the file appear as ghost
   **portal nodes** — double-click one to jump across the codebase without ever grepping.
5. **Drill into a declaration → L5.** Its highlighted source, flanked by clickable
   **Used by** / **Uses** columns. Identifiers in the source the graph can resolve are
   links too, imported names on the first line included.
6. **Back** (button, Backspace, or browser back) returns to the *exact* prior view —
   scroll, zoom, and selection preserved. **⌘K** fuzzy-searches every symbol.

## How it works

```
packages/
  core/      graph IR + SQLite store (nodes, edges, materialized aggregate_edges)
  indexer/   two-layer extraction:
             A. structural — tree-sitter (WASM): files, imports/exports  → L1–L3 in seconds
             B. semantic   — LSP (typescript-language-server): symbols,
                call hierarchy, find-all-references, hover signatures    → L4/L5, streamed
  server/    the API itself (api.ts) + the Fastify HTTP/WS transport, CLI entry
  desktop/   Electron shell: window + menus, app:// bundle, IPC transport,
             one utility process per open repo holding store + indexer
  web/       React + React Flow canvas, ELK layered layout in a Web Worker,
             Shiki source views, zustand navigation stack
```

* **One aggregation rule.** Fine-grained edges are computed once (file→file imports,
  symbol→symbol calls and references); every coarser edge is a roll-up to the endpoints'
  lowest common ancestor. Levels never get analyzed separately.
* **Progressive indexing.** The structural layer lands first and the UI is usable
  immediately; call edges stream in over WebSocket as the LSP crawl proceeds. Results
  persist to SQLite (`~/.cache/lsp-viz/`), so reopening the same repo is instant, and
  **Re-index** diffs by mtime and re-crawls only what changed.
* **Crash-safe.** If the language server dies mid-crawl, it's restarted and the crawl
  resumes from the last completed file. Symbol ids are deterministic, so re-indexing is
  idempotent.
* **Desktop first, one implementation.** `createApi()` in `packages/server/api.ts` answers
  every question the UI can ask and knows nothing about transports. The CLI wraps it in
  Fastify routes; the desktop app calls the same methods over Electron IPC. The frontend
  picks its transport by feature-detecting the preload bridge, so **one Vite bundle** runs
  in both — there is no desktop build of the UI.
* **Language-pluggable.** Everything language-specific (server command, extensions,
  tree-sitter grammar + queries, import resolution) lives behind a `LanguageAdapter`.
  The crawler contains zero TypeScript-specific logic.

## CLI

```
lsp-viz <path-to-repo> [--port 4977] [--no-open] [--db <path>] [--reindex]
```

## Development

```bash
pnpm build            # build all packages (topological)
pnpm test             # core + indexer + server test suites (vitest)
pnpm typecheck        # strict TS across the monorepo
pnpm --filter @lsp-viz/web dev   # frontend dev server (proxies /api and /ws to :4977)

pnpm desktop -- --repo ./fixtures/demo-repo   # run the Electron app on a repo
pnpm desktop:pack     # unpacked .app / dir build, for local testing
pnpm desktop:dist     # installers (dmg + zip / nsis / AppImage + deb)
```

Two harnesses boot the real main process and assert on what it does — worth running
after touching anything in `packages/desktop`:

```bash
cd packages/desktop
npx electron scripts/smoke.mjs --repo ../../fixtures/demo-repo --out /tmp/shot.png
npx electron scripts/close-test.mjs --repo ../../fixtures/demo-repo
```

`smoke.mjs` reports renderer console errors, preload failures, render-process crashes and
what the page actually rendered, and saves a screenshot. `close-test.mjs` closes the window
and quits, asserting neither throws in the main process — `closed` fires *after* the
WebContents is destroyed, so teardown that touches `window.webContents` crashes the app on
every window close.

### Packaging notes

* **No node-gyp.** `better-sqlite3` v13 is Node-API (`NAPI_VERSION=10`) with per-platform
  prebuilds, and Node-API is ABI-stable across runtimes — Electron 39 ships Node 22 /
  NAPI 10, so it loads the stock prebuild unchanged. `npmRebuild: false`.
* **`asarUnpack` is load-bearing.** The tree-sitter grammars, `typescript-language-server`,
  and the `.node` binary are resolved with `require.resolve` and then spawned or read off
  disk, which needs real paths rather than virtual ones inside the archive.
* **The language server needs no separate Node.** It is spawned as
  `process.execPath <tsserver-cli> --stdio` with `ELECTRON_RUN_AS_NODE=1`, i.e. the app's
  own binary re-executed as plain Node — the same trick VS Code uses.
* **Relative `--repo` resolves against `INIT_CWD`.** `pnpm --filter` runs a package script
  with the cwd set to that package, so `pnpm desktop -- --repo ./fixtures/demo-repo` typed
  at the repo root would otherwise look under `packages/desktop/`. Package managers set
  `INIT_CWD` to the invocation directory for exactly this; a packaged app has none and
  falls back to cwd. (`npx` sets its own `INIT_CWD` — relevant only if you wrap the
  command.)
* Shipping to other machines additionally needs a Developer ID + notarization (macOS) and
  a signing certificate (Windows). Neither is configured here.

Docs: [docs/BRIEF.md](docs/BRIEF.md) (product spec) ·
[docs/CONTRACTS.md](docs/CONTRACTS.md) (internal API contracts).
