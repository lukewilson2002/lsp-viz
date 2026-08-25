/**
 * Thin wrapper around web-tree-sitter 0.26: one-time init, Language cache per
 * wasm path, compiled Query cache per (language, query source), and a parser
 * pool keyed by language.
 */

import { Language, Parser, Query } from 'web-tree-sitter';
import type { QueryCapture, Tree } from 'web-tree-sitter';

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<Language, Parser>();
const queryCache = new Map<Language, Map<string, Query>>();

function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

/** Load (and cache) the Language for a grammar wasm file. */
export async function getLanguage(absWasmPath: string): Promise<Language> {
  let cached = languageCache.get(absWasmPath);
  if (!cached) {
    cached = ensureInit().then(() => Language.load(absWasmPath));
    languageCache.set(absWasmPath, cached);
  }
  return cached;
}

function parserFor(language: Language): Parser {
  let parser = parserCache.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(language, parser);
  }
  return parser;
}

/** Compile (and cache) a query against a language. */
export function getQuery(language: Language, querySource: string): Query {
  let perLang = queryCache.get(language);
  if (!perLang) {
    perLang = new Map();
    queryCache.set(language, perLang);
  }
  let query = perLang.get(querySource);
  if (!query) {
    query = new Query(language, querySource);
    perLang.set(querySource, query);
  }
  return query;
}

/**
 * Parse `source` with `language`. Caller must `tree.delete()` when done
 * (use {@link withTree} to make that automatic).
 */
export function parseSource(language: Language, source: string): Tree {
  const tree = parserFor(language).parse(source);
  if (!tree) throw new Error('tree-sitter parse returned null');
  return tree;
}

/** Parse, run `fn` over the tree, and free the tree afterwards. */
export function withTree<T>(language: Language, source: string, fn: (tree: Tree) => T): T {
  const tree = parseSource(language, source);
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}

/** Run a (cached) query over a parsed source, returning raw captures. */
export function captureAll(language: Language, querySource: string, tree: Tree): QueryCapture[] {
  return getQuery(language, querySource).captures(tree.rootNode);
}
