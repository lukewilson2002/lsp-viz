/**
 * Syntax-highlighted source with real line numbers (CSS counters seeded from
 * the file's true start line). Identifiers matching known callee names are
 * post-processed into clickable links that navigate to that node; clicks are
 * event-delegated on the container.
 */

import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import { langFor, useHighlightedHtml } from '../highlight';
import { useAppStore } from '../state/store';

export interface CodeLink {
  name: string;
  nodeId: string;
}

export interface SourceViewProps {
  text: string;
  /** Repo-relative path — used only to disambiguate tsx/jsx within `language`. */
  path: string;
  /** The node's language (its LanguageAdapter id, e.g. 'typescript'). */
  language: string;
  /** 1-based line number of the first line of `text` in the real file. */
  startLine: number;
  /** Known outgoing callees: identifiers matching these become links. */
  links?: readonly CodeLink[];
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Post-process Shiki's HTML: seed the line-number counter with the real start
 * line and wrap callee identifiers in `[data-node-id]` links. Runs on a
 * detached DOM (DOMParser) — never on live nodes React owns.
 */
function postprocessHighlighted(
  html: string,
  startLine: number,
  links: readonly CodeLink[],
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
    const pattern = new RegExp(`\\b(${[...byName.keys()].map(escapeRegExp).join('|')})\\b`);
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }
    for (const textNode of textNodes) {
      let node: Text | null = textNode;
      while (node) {
        const match = node.data.match(pattern);
        if (!match || match.index === undefined) break;
        const name = match[1] ?? match[0];
        const nodeId = byName.get(name);
        if (nodeId === undefined) break;
        const linkText = node.splitText(match.index);
        const rest = linkText.splitText(name.length);
        const anchor = doc.createElement('a');
        anchor.className = 'code-link';
        anchor.setAttribute('data-node-id', nodeId);
        anchor.setAttribute('title', `Go to ${name}`);
        linkText.parentNode?.replaceChild(anchor, linkText);
        anchor.appendChild(linkText);
        node = rest;
      }
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
