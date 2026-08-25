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
pnpm install && pnpm build && pnpm lsp-viz ./fixtures/demo-repo
```

That indexes the bundled fixture monorepo and opens the browser. Try it on a real repo:

```bash
pnpm lsp-viz /path/to/your/repo
```

Demo flow, 60 seconds:

1. **L1 — Workspace.** The repo's packages, edges weighted by import count.
2. **Double-click a package → L2.** Its directories, entry points badged.
3. **Drill again → L3.** Files, with export summaries, wired by imports.
4. **Drill into a file → L4.** Its declarations connected by *call* edges; calls that
   leave the file appear as ghost **portal nodes** — double-click one to jump across
   the codebase without ever grepping.
5. **Drill into a function → L5.** Its highlighted source, flanked by clickable callers
   and callees.
6. **Back** (button, Backspace, or browser back) returns to the *exact* prior view —
   scroll, zoom, and selection preserved. **⌘K** fuzzy-searches every symbol.

## How it works

```
packages/
  core/      graph IR + SQLite store (nodes, edges, materialized aggregate_edges)
  indexer/   two-layer extraction:
             A. structural — tree-sitter (WASM): files, imports/exports  → L1–L3 in seconds
             B. semantic   — LSP (typescript-language-server): symbols,
                call hierarchy, hover signatures                         → L4/L5, streamed
  server/    Fastify HTTP + WebSocket API, serves the built frontend, CLI entry
  web/       React + React Flow canvas, ELK layered layout in a Web Worker,
             Shiki source views, zustand navigation stack
```

* **One aggregation rule.** Fine-grained edges are computed once (file→file imports,
  symbol→symbol calls); every coarser edge is a roll-up to the endpoints' lowest common
  ancestor. Levels never get analyzed separately.
* **Progressive indexing.** The structural layer lands first and the UI is usable
  immediately; call edges stream in over WebSocket as the LSP crawl proceeds. Results
  persist to SQLite (`~/.cache/lsp-viz/`), so reopening the same repo is instant, and
  **Re-index** diffs by mtime and re-crawls only what changed.
* **Crash-safe.** If the language server dies mid-crawl, it's restarted and the crawl
  resumes from the last completed file. Symbol ids are deterministic, so re-indexing is
  idempotent.
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
pnpm test             # core + indexer test suites (vitest)
pnpm typecheck        # strict TS across the monorepo
pnpm --filter @lsp-viz/web dev   # frontend dev server (proxies /api and /ws to :4977)
```

Docs: [docs/BRIEF.md](docs/BRIEF.md) (product spec) ·
[docs/CONTRACTS.md](docs/CONTRACTS.md) (internal API contracts).
