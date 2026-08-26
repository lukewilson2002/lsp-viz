/**
 * One collapsible section of the Details tab. The open/closed bit lives in the
 * store keyed by SECTION rather than by node id: "I don't want to read all the
 * code" is a standing preference about a kind of information, so it has to
 * survive selection changes (which remount this whole pane), Back/forward and
 * a re-index.
 */

import type { ReactNode } from 'react';
import type { DetailSectionId } from '../state/store';
import { useAppStore } from '../state/store';

export function DetailSection({
  id,
  label,
  count,
  className,
  children,
}: {
  id: DetailSectionId;
  label: string;
  /** Right-aligned chip: a total, a line range — anything short and factual. */
  count?: string;
  /** Extra class on the section wrapper (e.g. `detail-section--source`). */
  className?: string;
  children: ReactNode;
}) {
  const collapsed = useAppStore((s) => s.detailCollapsed[id] === true);
  const toggleDetailSection = useAppStore((s) => s.toggleDetailSection);
  const bodyId = `detail-section-${id}`;

  return (
    <section className={`detail-section${className ? ` ${className}` : ''}`}>
      <button
        className="detail-section-head"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => toggleDetailSection(id)}
      >
        <span className="detail-section-chevron" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
        <span>{label}</span>
        {count !== undefined ? <span className="detail-section-count">{count}</span> : null}
      </button>
      {collapsed ? null : (
        <div className="detail-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
