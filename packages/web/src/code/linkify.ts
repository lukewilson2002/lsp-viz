/**
 * Turning identifiers in highlighted code into `[data-node-id]` links.
 *
 * This is the half of "clickable source" that has nothing to do with WHICH
 * surface is showing the code: the full-file slice in the L5 view and the
 * sidebar, and the one-line declaration on a node card, all need the same
 * answer to "is this occurrence of `format` really the declaration called
 * `format`?" — so all three run this pass over their own detached DOM.
 *
 * The candidate names arrive resolved from the server (GET /api/links/:id) —
 * unique by name, ambiguity already dropped there — so this pass only has to
 * decide WHERE in the text a name is really an identifier. Three things that
 * look nothing like: text inside a string or a comment (Shiki tags those
 * tokens `data-tok="skip"`), a longer identifier that merely contains the name
 * (`\b` does not know that `$` is an identifier character, so it splits
 * `mean$raw`), and a member access — `values.length` names a property of
 * `values`, never the top-level declaration called `length`.
 */

import type { SourceLink } from '@lsp-viz/core';

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
 * Wrap every linkable identifier under `root` in an anchor, in place.
 *
 * `root` must belong to a DETACHED document (DOMParser), never to live nodes
 * React owns — this splits and replaces text nodes as it goes.
 */
export function linkifyIdentifiers(
  doc: Document,
  root: Element,
  links: readonly SourceLink[],
): void {
  const byName = new Map<string, string>();
  for (const link of links) {
    if (IDENTIFIER_RE.test(link.name) && !byName.has(link.name)) {
      byName.set(link.name, link.nodeId);
    }
  }
  if (byName.size === 0) return;

  const names = [...byName.keys()].map(escapeRegExp).join('|');
  const pattern = new RegExp(`${BOUNDARY_BEFORE}(${names})${BOUNDARY_AFTER}`);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
