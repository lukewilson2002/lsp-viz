/**
 * One shared Shiki highlighter for the whole app (sidebar Details tab + L5
 * source). Lazily initialized via dynamic import so the shiki chunk never
 * blocks first paint; theme picked by prefers-color-scheme.
 *
 * Shiki v4 API (verified against node_modules/shiki/dist typings):
 * `createHighlighter({ themes, langs })` → Promise<Highlighter>, then the
 * synchronous `highlighter.codeToHtml(code, { lang, theme })`. The web bundle
 * (`shiki/bundle/web`) covers typescript/tsx + the github themes while
 * keeping dozens of unrelated grammar chunks out of the build output.
 *
 * Tokens are additionally tagged with `data-tok="skip"` where the text is a
 * string body or a comment, so the source view can link identifiers without
 * linking the word `mean` inside a string literal.
 */

import { useEffect, useState } from 'react';
import type { Highlighter } from 'shiki/bundle/web';

export type HighlightLang = 'typescript' | 'tsx';
export type HighlightTheme = 'github-dark' | 'github-light';

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lazily create (once) and return the shared highlighter. */
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki/bundle/web').then((shiki) =>
    shiki.createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: ['typescript', 'tsx'],
    }),
  );
  return highlighterPromise;
}

/**
 * Shiki grammar for a node's language (the id its LanguageAdapter registered,
 * e.g. 'typescript') plus its path, used only to disambiguate tsx/jsx within
 * that language family. A language with no registered grammar returns null —
 * callers fall back to plain, unhighlighted text; this is how a future
 * adapter (Go, Rust, Python) degrades gracefully instead of being silently
 * mis-highlighted as TypeScript.
 */
const GRAMMAR_BY_LANGUAGE: Record<string, HighlightLang> = {
  typescript: 'typescript',
};

export function langFor(language: string, path: string): HighlightLang | null {
  const base = GRAMMAR_BY_LANGUAGE[language];
  if (base === undefined) return null;
  return base === 'typescript' && (path.endsWith('.tsx') || path.endsWith('.jsx'))
    ? 'tsx'
    : base;
}

/**
 * Scopes whose text is prose, not code: string bodies, comments, and the
 * quote/slash punctuation that delimits them. Matched against a token's
 * INNERMOST scope only — a template literal's substitution carries the
 * enclosing `string.template.ts` in its scope stack, so testing the whole
 * stack would silently drop every identifier inside `${...}`.
 */
const SKIP_SCOPE = /^(string|comment)\b|^punctuation\.definition\.(string|comment)\b/;

/** Marker consumed by the source view's identifier pass. */
const SKIP_ATTR = 'data-tok';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Reactive prefers-color-scheme: light flag. */
export function usePrefersLight(): boolean {
  const [light, setLight] = useState<boolean>(() => window.matchMedia(LIGHT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(LIGHT_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setLight(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return light;
}

/** The one call into Shiki; every hook below goes through it. */
function toHtml(highlighter: Highlighter, text: string, lang: HighlightLang, light: boolean): string {
  return highlighter.codeToHtml(text, {
    lang,
    theme: light ? 'github-light' : 'github-dark',
    // Tells identifier linking where the code ISN'T: without it a data
    // label `'mean'` and every JSDoc mention of a symbol become links.
    includeExplanation: 'scopeName',
    transformers: [
      {
        name: 'lsp-viz:mark-prose',
        span(hast, _line, _col, _lineElement, token) {
          const scopes = token.explanation?.[0]?.scopes ?? [];
          const innermost = scopes[scopes.length - 1]?.scopeName ?? '';
          if (SKIP_SCOPE.test(innermost)) hast.properties[SKIP_ATTR] = 'skip';
        },
      },
    ],
  });
}

/**
 * Highlight `text` into Shiki HTML for the current color scheme.
 * Returns null while the highlighter chunk is still loading (callers render a
 * plain-text fallback so content is never delayed).
 */
export function useHighlightedHtml(text: string | null, lang: HighlightLang | null): string | null {
  const light = usePrefersLight();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (text === null || lang === null) return;
    let cancelled = false;
    getHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        setHtml(toHtml(highlighter, text, lang, light));
      })
      .catch(() => {
        // Highlighter failed to load — the plain fallback stays up.
      });
    return () => {
      cancelled = true;
    };
  }, [text, lang, light]);

  return html;
}

/**
 * The same, memoized across component lifetimes — for the SHORT snippets that
 * are rendered many at a time and remount constantly: a canvas view holds
 * dozens of signature blocks and React Flow rebuilds every card on each
 * layout. Without the cache each rebuild re-tokenizes every signature and
 * flashes the plain fallback on the way back; with it a cached snippet is
 * returned on the very first render, before any effect runs.
 *
 * Bounded and dropped wholesale when full: entries are cheap and short-lived,
 * and an LRU's bookkeeping would cost more than the re-highlight it saves.
 */
const snippetCache = new Map<string, string>();
const SNIPPET_CACHE_MAX = 600;

function snippetKey(text: string, lang: HighlightLang, light: boolean): string {
  return `${light ? 'l' : 'd'}|${lang}|${text}`;
}

export function useHighlightedCode(text: string, lang: HighlightLang | null): string | null {
  const light = usePrefersLight();
  const key = lang === null ? null : snippetKey(text, lang, light);
  const [html, setHtml] = useState<string | null>(() =>
    key === null ? null : (snippetCache.get(key) ?? null),
  );

  useEffect(() => {
    if (key === null || lang === null) {
      setHtml(null);
      return;
    }
    const cached = snippetCache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    setHtml(null);
    let cancelled = false;
    getHighlighter()
      .then((highlighter) => {
        const rendered = toHtml(highlighter, text, lang, light);
        if (snippetCache.size >= SNIPPET_CACHE_MAX) snippetCache.clear();
        snippetCache.set(key, rendered);
        if (!cancelled) setHtml(rendered);
      })
      .catch(() => {
        // Highlighter failed to load — the plain fallback stays up.
      });
    return () => {
      cancelled = true;
    };
  }, [key, text, lang, light]);

  return html;
}
