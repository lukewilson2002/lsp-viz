/**
 * One shared Shiki highlighter for the whole app (inspector preview + L5
 * source). Lazily initialized via dynamic import so the shiki chunk never
 * blocks first paint; theme picked by prefers-color-scheme.
 *
 * Shiki v4 API (verified against node_modules/shiki/dist typings):
 * `createHighlighter({ themes, langs })` → Promise<Highlighter>, then the
 * synchronous `highlighter.codeToHtml(code, { lang, theme })`. The web bundle
 * (`shiki/bundle/web`) covers typescript/tsx + the github themes while
 * keeping dozens of unrelated grammar chunks out of the build output.
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
        setHtml(
          highlighter.codeToHtml(text, {
            lang,
            theme: light ? 'github-light' : 'github-dark',
          }),
        );
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
