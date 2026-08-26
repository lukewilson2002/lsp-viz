/**
 * The sidebar's tab strip. Rendered unconditionally — a tab bar that appeared
 * and disappeared with the selection would shift the pane below it by ~30px on
 * every click.
 *
 * The second tab is labelled with the selected node's own name rather than the
 * word "Details": a name-bearing tab says what the tab holds without switching
 * to it. Its × deselects, because closing that tab and dropping the selection
 * are the same act.
 */

import { kindGlyph } from '../canvas/glyphs';
import type { SidebarTab } from '../state/store';
import { useAppStore } from '../state/store';

export function SidebarTabs({
  tab,
  detailsId,
}: {
  tab: SidebarTab;
  /** The selected node, or null when the details tab shouldn't exist. */
  detailsId: string | null;
}) {
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const select = useAppStore((s) => s.select);
  const node = useAppStore((s) =>
    detailsId !== null ? (s.nodeDetails[detailsId]?.node ?? null) : null,
  );

  return (
    <div className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
      <button
        role="tab"
        aria-selected={tab === 'files'}
        className={`sidebar-tab${tab === 'files' ? ' sidebar-tab--active' : ''}`}
        onClick={() => setSidebarTab('files')}
      >
        Files
      </button>
      {detailsId !== null ? (
        <button
          role="tab"
          aria-selected={tab === 'details'}
          className={`sidebar-tab sidebar-tab--details${tab === 'details' ? ' sidebar-tab--active' : ''}`}
          onClick={() => setSidebarTab('details')}
          title={node ? `${node.name} — ${node.path}` : 'Selected node'}
        >
          {node ? (
            <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
              {kindGlyph(node.kind)}
            </span>
          ) : null}
          <span className="sidebar-tab-label">{node?.name ?? 'Details'}</span>
          <span
            className="sidebar-tab-close"
            role="button"
            tabIndex={-1}
            aria-label="Deselect"
            title="Deselect (Escape)"
            onClick={(event) => {
              event.stopPropagation();
              select(null);
            }}
          >
            ×
          </span>
        </button>
      ) : null}
    </div>
  );
}
