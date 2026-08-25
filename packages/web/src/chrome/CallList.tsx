import type { CallLink } from '@lsp-viz/core';
import { kindGlyph } from '../canvas/glyphs';
import { useAppStore } from '../state/store';

/** Clickable caller/callee rows — shared by the inspector and the L5 view. */
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
