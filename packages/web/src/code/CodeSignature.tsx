/**
 * A declaration's signature, rendered as CODE rather than as a caption.
 *
 * The signature is the densest thing the app shows about a symbol — it names
 * the types it takes and returns — so it gets the same two affordances as any
 * other code in the app: Shiki highlighting, and identifiers that navigate.
 * The three surfaces that show one (node cards, the sidebar's Details tab, the
 * L5 header) all render this, so "click a type to go to it" never depends on
 * which one you happen to be looking at.
 *
 * Highlighting is best-effort: until the Shiki chunk loads — and forever, for
 * a language with no registered grammar — the same plain text renders, WITH
 * its links, because linking is a graph fact and does not depend on a grammar.
 */

import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import type { SourceLink } from '@lsp-viz/core';
import { langFor, useHighlightedCode } from '../highlight';
import { linkifyIdentifiers } from './linkify';
import { useCodeLinkClick } from './useCodeLinkClick';

export interface CodeSignatureProps {
  /** The signature text, verbatim from the server (never parsed). */
  signature: string;
  /** The node's language id (its LanguageAdapter id, e.g. 'typescript'). */
  language: string;
  /** Repo-relative path — only disambiguates tsx/jsx within `language`. */
  path: string;
  /** Identifiers the graph can resolve; occurrences of these become links. */
  links?: readonly SourceLink[];
  /** Class on the wrapper — each surface keeps its own box styling. */
  className?: string;
  /** Extra hook for the surface (cards fetch their links on first hover). */
  onMouseEnter?: () => void;
}

/** True when the event started on a code link rather than on the box. */
function onLink(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest('[data-node-id]') !== null;
}

export function CodeSignature({
  signature,
  language,
  path,
  links,
  className,
  onMouseEnter,
}: CodeSignatureProps) {
  const onClick = useCodeLinkClick();
  const html = useHighlightedCode(signature, langFor(language, path));

  const processed = useMemo(() => {
    // One detached parse does both jobs: unwrap Shiki's <pre><code> (the box
    // here is the caller's, not Shiki's) and wrap the linkable identifiers.
    const doc = new DOMParser().parseFromString(html ?? '<code></code>', 'text/html');
    const code = doc.querySelector('code');
    if (code === null) return null;
    if (html === null) code.textContent = signature;
    linkifyIdentifiers(doc, code, links ?? []);
    return code.innerHTML;
  }, [html, signature, links]);

  if (processed === null) return <code className={className}>{signature}</code>;

  return (
    <code
      className={className}
      title={signature}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      // Double-clicking a LINK must navigate, not also drill into the card the
      // link sits in; double-clicking the box anywhere else still drills.
      // (Dragging is handled by the caller's class — a card passes `nodrag`,
      // which trades dragging the card by its signature for selecting the
      // text of it.)
      onMouseDown={(event) => {
        if (onLink(event)) event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        if (onLink(event)) event.stopPropagation();
      }}
      dangerouslySetInnerHTML={{ __html: processed }}
    />
  );
}
