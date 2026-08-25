/**
 * Cmd/Ctrl-K fuzzy search palette: centered modal over the app, debounced
 * /api/search, keyboard-driven (arrows + Enter + Escape), Enter/click
 * navigates to the picked node.
 */

import type { SearchResult } from '@lsp-viz/core';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { fetchSearch } from '../api/client';
import { kindGlyph } from '../canvas/glyphs';
import { useAppStore } from '../state/store';

const DEBOUNCE_MS = 150;

/** Wrap the (case-insensitive) query substring of `name` in a highlight. */
function highlightName(name: string, query: string): ReactNode {
  const q = query.trim();
  if (q === '') return name;
  const index = name.toLowerCase().indexOf(q.toLowerCase());
  if (index === -1) return name;
  return (
    <>
      {name.slice(0, index)}
      <mark className="palette-hit">{name.slice(index, index + q.length)}</mark>
      {name.slice(index + q.length)}
    </>
  );
}

export function SearchPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const navigateToNode = useAppStore((s) => s.navigateToNode);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset + focus on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      setLoading(false);
      // Focus after the modal paints.
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return undefined;
    const q = query.trim();
    if (q === '') {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const t = window.setTimeout(() => {
      fetchSearch(q)
        .then((res) => {
          setResults(res.results);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch(() => {
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open]);

  // Keep the active row in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector('.palette-row--active');
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);

  if (!open) return null;

  const choose = (index: number): void => {
    const result = results[index];
    if (!result) return;
    setPaletteOpen(false);
    void navigateToNode(result.node.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
        break;
      case 'Enter':
        event.preventDefault();
        choose(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        setPaletteOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="palette" role="dialog" aria-label="Search symbols">
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={query}
          placeholder="Search symbols, files, packages…"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {query.trim() !== '' ? (
          <ul className="palette-results" ref={listRef}>
            {results.map((result, index) => (
              <li key={result.node.id}>
                <button
                  className={`palette-row${index === activeIndex ? ' palette-row--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span className={`kind-glyph kind-glyph--${result.node.kind}`} aria-hidden>
                    {kindGlyph(result.node.kind)}
                  </span>
                  <span className="palette-name">{highlightName(result.node.name, query)}</span>
                  <span className="palette-path">{result.node.path}</span>
                </button>
              </li>
            ))}
            {!loading && results.length === 0 ? (
              <li className="palette-empty">No matches for “{query.trim()}”</li>
            ) : null}
          </ul>
        ) : (
          <div className="palette-hint">
            Type to search · ↑↓ to move · Enter to jump · Esc to close
          </div>
        )}
      </div>
    </div>
  );
}
