/**
 * Syntax-highlighted source with real line numbers (CSS counters seeded from
 * the file's true start line). Identifiers naming something the graph knows are
 * post-processed into clickable links that navigate to that node; clicks are
 * event-delegated on the container.
 *
 * WHICH identifiers those are, and where in the text they really are
 * identifiers, is `code/linkify.ts` — shared with the declaration signatures
 * on cards and in the detail panes, so every piece of code in the app is
 * clickable by the same rules.
 */

import { useMemo } from 'react';
import type { SourceLink } from '@lsp-viz/core';
import { langFor, useHighlightedHtml } from '../highlight';
import { linkifyIdentifiers } from './linkify';
import { useCodeLinkClick } from './useCodeLinkClick';

export interface SourceViewProps {
  text: string;
  /** Repo-relative path — used only to disambiguate tsx/jsx within `language`. */
  path: string;
  /** The node's language (its LanguageAdapter id, e.g. 'typescript'). */
  language: string;
  /** 1-based line number of the first line of `text` in the real file. */
  startLine: number;
  /** Identifiers the graph can resolve; occurrences of these become links. */
  links?: readonly SourceLink[];
}

/**
 * Post-process Shiki's HTML: seed the line-number counter with the real start
 * line and wrap known identifiers in `[data-node-id]` links. Runs on a
 * detached DOM (DOMParser) — never on live nodes React owns.
 */
function postprocessHighlighted(
  html: string,
  startLine: number,
  links: readonly SourceLink[],
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pre = doc.querySelector('pre');
  if (!pre) return html;
  pre.style.counterReset = `line ${startLine - 1}`;
  linkifyIdentifiers(doc, pre, links);
  return pre.outerHTML;
}

/** Plain (unhighlighted) fallback shown while the shiki chunk loads. */
function PlainSource({ text, startLine }: { text: string; startLine: number }) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return (
    <pre className="shiki source-plain" style={{ counterReset: `line ${startLine - 1}` }}>
      <code>
        {lines.map((line, i) => (
          <span key={i} className="line">
            {line}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function SourceView({ text, path, language, startLine, links }: SourceViewProps) {
  const onClick = useCodeLinkClick();
  const html = useHighlightedHtml(text, langFor(language, path));

  const processed = useMemo(
    () => (html === null ? null : postprocessHighlighted(html, startLine, links ?? [])),
    [html, startLine, links],
  );

  if (processed === null) {
    return (
      <div className="source-view">
        <PlainSource text={text} startLine={startLine} />
      </div>
    );
  }
  return (
    <div className="source-view" onClick={onClick} dangerouslySetInnerHTML={{ __html: processed }} />
  );
}
