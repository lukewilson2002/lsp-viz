import type { GraphStore, IndexPhase, IndexStats, NodeKind } from '@lsp-viz/core';

/** A workspace package discovered by the crawler (repo-relative paths). */
export interface WorkspacePackage {
  name: string;
  dir: string;
  /** Entry-point source files (main/module/exports/bin), repo-relative. */
  entryPaths: string[];
}

export interface ResolveContext {
  repoRoot: string;
  packages: readonly WorkspacePackage[];
  /** Existence check for a repo-relative path. */
  fileExists(relPath: string): boolean;
}

/**
 * Everything language-specific lives here. The crawler and LSP client must
 * contain zero TypeScript-specific logic outside an adapter.
 */
export interface LanguageAdapter {
  id: string;
  displayName: string;
  /** File extensions this adapter owns, with leading dot. */
  extensions: readonly string[];
  /** Absolute path to the tree-sitter grammar wasm for the given file. */
  grammarWasmPath(relFilePath: string): string;
  /** Tree-sitter query; every import specifier captured as @source. */
  importQuery: string;
  /** Tree-sitter query; every exported top-level name captured as @name. */
  exportQuery: string;
  /**
   * Resolve an import specifier from `fromRelPath` to a repo-relative source
   * file path, or null when the target is outside the repo (external package).
   */
  resolveImport(specifier: string, fromRelPath: string, ctx: ResolveContext): string | null;
  /**
   * Map a package entry path the walk cannot see (typically build output like
   * dist/index.js) to the walked source file it is built from; null if unknown.
   */
  resolveEntrySource?(entryRelPath: string, pkg: WorkspacePackage, ctx: ResolveContext): string | null;
  /**
   * The LSP `languageId` to open `relFilePath` with (`textDocument/didOpen`).
   *
   * MANDATORY where one adapter owns several dialects of the same language:
   * the server picks its PARSER from this string, not from the file
   * extension. Opening a `.tsx` file as `typescript` makes tsserver parse
   * every JSX tag as a type assertion, and `documentSymbol` then answers with
   * the object literals and calls of that misparse instead of the file's real
   * declarations.
   *
   * Defaults to {@link id} when the adapter does not implement it.
   */
  languageIdFor?(relFilePath: string): string;
  /** How to launch this language's LSP server. */
  lspCommand(repoRoot: string): { command: string; args: readonly string[] };
  /** Map an LSP SymbolKind number to an IR NodeKind; null = skip the symbol. */
  mapSymbolKind(lspSymbolKind: number): NodeKind | null;
  /**
   * Declaration modifier keywords, for putting back what hover drops.
   *
   * A hover describes a symbol's TYPE, not the line that declares it, so
   * tsserver answers `export async function f()` with `function f()`. These
   * are the words the semantic pass is allowed to recover from the source
   * text ahead of the symbol's name; anything not listed here is left alone.
   */
  declarationModifiers?: readonly string[];
}

export type IndexProgressEvent =
  | { type: 'phase'; phase: IndexPhase }
  | {
      type: 'progress';
      phase: IndexPhase;
      filesDone: number;
      filesTotal: number;
      currentFile?: string;
      symbols?: number;
      callEdges?: number;
    }
  | { type: 'done'; stats: IndexStats }
  | { type: 'error'; message: string };

export type IndexMode = 'full' | 'diff';

export interface IndexerOptions {
  /** Absolute path to the repo being indexed. */
  repoRoot: string;
  store: GraphStore;
  /** Defaults to [typescriptAdapter]. */
  adapters?: readonly LanguageAdapter[];
  onProgress?: (event: IndexProgressEvent) => void;
  /** Max in-flight LSP requests (default 16). */
  concurrency?: number;
}

export interface Indexer {
  /**
   * Run a full index or an mtime diff. Structural layer completes first (the
   * graph is browsable from that moment); semantic results stream in after.
   * Resolves when everything (including aggregate materialization) is done.
   */
  run(mode: IndexMode): Promise<IndexStats>;
  cancel(): Promise<void>;
  readonly running: boolean;
}
