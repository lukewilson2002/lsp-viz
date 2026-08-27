# lsp-viz

**Explore a codebase visually**

Watch the demo (2 min):

![Demo video showcasing the app as it views its own source code.](media/lsp-viz-demo.mp4)

Point lsp-viz at a repo and it builds an interactive, infinitely-nestable graph of the
code, modeled on [C4 diagram](https://c4model.com/) zoom levels: every view answers one
question at one level of abstraction, and drilling down answers the next-more-specific
one.

Semantic analysis flows through the Language Server Protocol, so new languages are added
by registering a language server — not by writing new analysis code. TypeScript is the only
adapter currently.

## Try It Yourself

### From source

```bash
pnpm install && pnpm build && pnpm desktop
```

That launches the desktop app; pick a repo from the open dialog (or pass one via
`pnpm desktop -- --repo ./fixtures/demo-repo`). It will index your codebase/repo,
and then opens in a window.

The same build also ships as a CLI that serves the UI over HTTP, which is handy over SSH:

```bash
pnpm lsp-viz /path/to/your/repo
```

The repo caches are stored in SQLite DB files in `~/.cache/lsp-viz/`. Files only need
to be reindexed if there are changes since the last indexing run.

## CLI

Note: the CLI is in early stages. I plan to make the CLI an alternative interface for
agents to explore codebases semantically. For now, it's just a webserver.

```
lsp-viz <path-to-repo> [--port 4977] [--no-open] [--db <path>] [--reindex]
```

## Development

A lot of the development has been done with agents -- primarily Claude Code. I just would
not have been able to make this without them, as it would have been too time consuming.
With upfront planning and design, we can lead agents to create really awesome things.
Feel free to open a PR if you think anything could be improved. But if you plan on making
a lot of changes, then consider reading the section on Contributing, below.

### Common Commands

```bash
pnpm build            # build all packages
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

### Docs

- [docs/BRIEF.md](docs/BRIEF.md) (product spec)
- [docs/CONTRACTS.md](docs/CONTRACTS.md) (internal API contracts)

## Contributing

Contributors are welcome! But since a lot of code can be produced by agents in pursuit of 
new features or changes, I ask if you would kindly open an issue to discuss your ideas
before creating a pull request. We can hash out the details together and make something
awesome. If it's just a bug fix, feel free to PR it.

No obviously AI-written PR descriptions. Either write it in your own words or spend the 
time making it useful for reviewers.

Thanks!

