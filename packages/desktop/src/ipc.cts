/**
 * The renderer<->main channel names, in a CommonJS module because the preload
 * script is sandboxed (and a sandboxed preload is always CJS). `.cts` compiles
 * to `.cjs`, which the ESM main process imports back — one definition, both
 * module systems, no drift between the string the preload listens on and the
 * string main answers on.
 *
 * Written in `import =` / `export =` form because the repo sets
 * `verbatimModuleSyntax`, which (correctly) refuses to let ESM syntax be
 * silently rewritten into `require` calls.
 */

const channels = {
  /** Renderer -> main: one API call. Answered with an `ApiReply`. */
  API: 'lspviz:api',
  /** Main -> renderer: one index progress event. */
  EVENT: 'lspviz:index-event',
  /** Renderer -> main: show the repo picker. Resolves true if a repo opened. */
  OPEN_REPO: 'lspviz:open-repo',
} as const;

export = channels;
