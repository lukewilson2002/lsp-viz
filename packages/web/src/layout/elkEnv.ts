/**
 * MUST be imported before 'elkjs/lib/elk.bundled.js' (ESM guarantees import
 * evaluation order).
 *
 * elkjs's bundled build sniffs its environment: when it sees no `document`
 * but a `self` (i.e. our Web Worker), it assumes it IS the layout worker,
 * hijacks `self.onmessage` with its own protocol and exports nothing — so
 * `new ELK()` crashes ("Worker is not a constructor"). Stubbing `document`
 * pushes it into library mode with its synchronous in-thread engine, which
 * is exactly what we want inside our own worker.
 */

const globalScope = globalThis as { document?: unknown };
if (globalScope.document === undefined) {
  globalScope.document = {};
}

export {};
