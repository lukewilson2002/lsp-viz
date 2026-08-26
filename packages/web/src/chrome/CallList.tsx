import type { CallLink } from '@lsp-viz/core';
import { kindGlyph } from '../canvas/glyphs';
import { useAppStore } from '../state/store';

/**
 * Clickable link rows — shared by the sidebar Details tab and L5.
 *
 * These are `CallLink`s by TYPE only. The list carries every edge kind
 * `nodeLinks` resolves — `references`, `extends` and `implements` alongside
 * `calls` — so the `empty` text its callers pass is deliberately written in
 * link-neutral language ("uses", not "calls"): a constant nothing CALLS is
 * still used by the function whose default parameter reads it.
 */
export function CallLinkList({ links, empty }: { links: readonly CallLink[]; empty: string }) {
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  if (links.length === 0) {
    return <div className="call-empty">{empty}</div>;
  }
  return (
    <ul className="call-list">
      {links.map((link) => (
        <li key={link.edge.id}>
          <button
            className="call-row"
            onClick={() => void navigateToNode(link.node.id)}
            title={`${link.node.name} — ${link.node.path}`}
          >
            <span className={`kind-glyph kind-glyph--${link.node.kind}`} aria-hidden>
              {kindGlyph(link.node.kind)}
            </span>
            <span className="call-name">{link.node.name}</span>
            {link.edge.count > 1 ? <span className="call-count">×{link.edge.count}</span> : null}
            <span className="call-path">{link.node.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
