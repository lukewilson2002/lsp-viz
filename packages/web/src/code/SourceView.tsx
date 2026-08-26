/**
 * Syntax-highlighted source with real line numbers (CSS counters seeded from
 * the file's true start line). Identifiers naming something the graph knows are
 * post-processed into clickable links that navigate to that node; clicks are
 * event-delegated on the container.
 *
 * The candidate names arrive resolved from the server (GET /api/links/:id) —
 * unique by name, ambiguity already dropped there — so this pass only has to
 * decide WHERE in the text a name is really an identifier. Three things that
 * looks nothing like: text inside a string or a comment (Shiki tags those
 * tokens `data-tok="skip"`), a longer identifier that merely contains the name
 * (`\b` does not know that `$` is an identifier character, so it splits
 * `mean$raw`), and a member access — `values.length` names a property of
 * `values`, never the top-level declaration called `length`.
 */

import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import type { SourceLink } from '@lsp-viz/core';
import { langFor, useHighlightedHtml } from '../highlight';
import { useAppStore } from '../state/store';

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

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Identifier boundaries done by hand: `\b` is `\w`-based and `\w` excludes
 * `$`, which both hides `$store` entirely and matches `mean` inside `$mean`.
 */
const BOUNDARY_BEFORE = '(?<![A-Za-z0-9_$])';
const BOUNDARY_AFTER = '(?![A-Za-z0-9_$])';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The last two non-whitespace characters of `text` ('' when there are none).
 * Two, not one, because one dot before a name means property access while
 * three mean a spread — and `...NODES` really does reference `NODES`.
 */
function trailingContext(text: string): string {
  return text.replace(/\s+$/, '').slice(-2);
}

/** True when `context` (the two chars before a name) makes it a member access. */
function isMemberAccess(context: string): boolean {
  return context.endsWith('.') && !context.endsWith('..');
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

  const byName = new Map<string, string>();
  for (const link of links) {
    if (IDENTIFIER_RE.test(link.name) && !byName.has(link.name)) {
      byName.set(link.name, link.nodeId);
    }
  }
  if (byName.size > 0) {
    const names = [...byName.keys()].map(escapeRegExp).join('|');
    const pattern = new RegExp(`${BOUNDARY_BEFORE}(${names})${BOUNDARY_AFTER}`);
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }
    // The characters before a match decide whether it is a member access, and
    // Shiki puts the `.` in a token span of its own — so the preceding text is
    // carried across text nodes rather than read from one of them.
    let preceding = '';
    for (const textNode of textNodes) {
      const original = textNode.data;
      const prose = textNode.parentElement?.closest('[data-tok="skip"]') != null;
      let node: Text | null = prose ? null : textNode;
      let carried = preceding;
      while (node) {
        const match = node.data.match(pattern);
        if (!match || match.index === undefined) break;
        const name = match[1] ?? match[0];
        const nodeId = byName.get(name);
        if (nodeId === undefined) break;
        const context = (carried + trailingContext(node.data.slice(0, match.index))).slice(-2);
        const linkText = node.splitText(match.index);
        const rest = linkText.splitText(name.length);
        if (!isMemberAccess(context)) {
          const anchor = doc.createElement('a');
          anchor.className = 'code-link';
          anchor.setAttribute('data-node-id', nodeId);
          anchor.setAttribute('title', `Go to ${name}`);
          linkText.parentNode?.replaceChild(anchor, linkText);
          anchor.appendChild(linkText);
        }
        carried = name.slice(-2);
        node = rest;
      }
      preceding = (preceding + trailingContext(original)).slice(-2);
    }
  }
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
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  const html = useHighlightedHtml(text, langFor(language, path));

  const processed = useMemo(
    () => (html === null ? null : postprocessHighlighted(html, startLine, links ?? [])),
    [html, startLine, links],
  );

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('[data-node-id]');
    if (!(link instanceof HTMLElement)) return;
    const id = link.getAttribute('data-node-id');
    if (id) {
      event.preventDefault();
      void navigateToNode(id);
    }
  };

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
