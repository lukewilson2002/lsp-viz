/**
 * L5 — focused leaf-symbol view: inbound links | Shiki-highlighted full source
 * with real line numbers | outbound links. Every row navigates; identifiers the
 * graph can resolve are clickable in the source AND in the signature above it.
 *
 * The columns are "Used by" / "Uses", not "Callers" / "Callees": these lists
 * carry every symbol-level edge kind, and this view is reached by variables and
 * types too — a constant is REFERENCED by the function whose default parameter
 * reads it, and calling that "Callers" describes the wrong relationship on the
 * very node most likely to be looked at here.
 *
 * The three columns start near-equal, are draggable, and remember where they
 * were put (see columnWidths.ts).
 */

import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { kindGlyph } from '../canvas/glyphs';
import { CodeSignature } from '../code/CodeSignature';
import { SourceView } from '../code/SourceView';
import { useCodeLinks } from '../code/useCodeLinks';
import { CallLinkList } from '../chrome/CallList';
import { selectTopEntry, useAppStore } from '../state/store';
import type { ColumnFractions } from './columnWidths';
import {
  DEFAULT_FRACTIONS,
  applyColumns,
  clearFractions,
  fractionPerPixel,
  loadFractions,
  resizeAt,
  saveFractions,
} from './columnWidths';

/** Drag-to-resize for the two dividers between the three columns. */
function useColumnResize(): {
  gridRef: (el: HTMLDivElement | null) => void;
  onPointerDown: (index: 0 | 1) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  onReset: () => void;
} {
  const gridElRef = useRef<HTMLDivElement | null>(null);
  const fractionsRef = useRef<ColumnFractions | null>(null);

  const gridRef = useCallback((el: HTMLDivElement | null) => {
    gridElRef.current = el;
    if (el === null) return;
    fractionsRef.current ??= loadFractions() ?? [...DEFAULT_FRACTIONS];
    applyColumns(el, fractionsRef.current);
  }, []);

  const onPointerDown = useCallback(
    (index: 0 | 1) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const grid = gridElRef.current;
      const start = fractionsRef.current;
      if (event.button !== 0 || grid === null || start === null) return;
      event.preventDefault();
      const startX = event.clientX;
      const perPixel = fractionPerPixel(start, grid.getBoundingClientRect().width);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('sidebar-resizing');

      let latest = start;
      const onMove = (moveEvent: PointerEvent): void => {
        latest = resizeAt(start, index, (moveEvent.clientX - startX) * perPixel);
        applyColumns(grid, latest);
      };
      const onUp = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        document.body.classList.remove('sidebar-resizing');
        fractionsRef.current = latest;
        saveFractions(latest);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    },
    [],
  );

  const onReset = useCallback(() => {
    clearFractions();
    fractionsRef.current = [...DEFAULT_FRACTIONS];
    applyColumns(gridElRef.current, fractionsRef.current);
  }, []);

  return { gridRef, onPointerDown, onReset };
}

function ColumnDivider({
  index,
  resize,
}: {
  index: 0 | 1;
  resize: ReturnType<typeof useColumnResize>;
}) {
  return (
    <div
      className="column-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={index === 0 ? 'Resize the Used by column' : 'Resize the Uses column'}
      title="Drag to resize · double-click to reset"
      onPointerDown={resize.onPointerDown(index)}
      onDoubleClick={resize.onReset}
    />
  );
}

export function FunctionView() {
  const entry = useAppStore(selectTopEntry);
  const l5 = useAppStore((s) => s.l5);
  const resize = useColumnResize();

  const slot = entry && l5?.nodeId === entry.nodeId ? l5 : null;
  const detail = slot?.detail ?? null;
  const source = slot?.source ?? null;
  const loading = slot?.loading ?? true;
  const error = slot?.error ?? null;

  const links = useCodeLinks(entry?.nodeId ?? null);

  if (!entry) return null;

  const node = detail?.node ?? null;
  const signature = node?.signature ?? '';

  return (
    <div className="function-view">
      <header className="function-view-header">
        <span className={`kind-glyph kind-glyph--${entry.kind}`} aria-hidden>
          {kindGlyph(entry.kind)}
        </span>
        <h2 className="function-view-name">{entry.name}</h2>
        <span className="function-view-kind">{entry.kind}</span>
      </header>
      {detail ? <div className="function-view-path">{detail.node.path}</div> : null}
      {error !== null ? <div className="function-view-error">{error}</div> : null}
      {node !== null && signature !== '' ? (
        <CodeSignature
          className="function-view-signature"
          signature={signature}
          language={node.language}
          path={node.path}
          links={links}
        />
      ) : (
        <pre className="function-view-signature">{loading ? 'Loading…' : entry.name}</pre>
      )}
      <div className="function-view-columns" ref={resize.gridRef}>
        <section className="function-view-panel">
          <h3>Used by{detail ? ` (${detail.metrics.inCount})` : ''}</h3>
          {detail ? (
            <CallLinkList links={detail.incoming} empty="Nothing uses this symbol" />
          ) : (
            <div className="function-view-placeholder">
              {loading ? <span className="spinner" aria-hidden /> : '—'}
            </div>
          )}
        </section>
        <ColumnDivider index={0} resize={resize} />
        <section className="function-view-panel function-view-source">
          <h3>Source</h3>
          {source ? (
            <SourceView
              text={source.text}
              path={source.path}
              language={source.language}
              startLine={source.startLine}
              links={links}
            />
          ) : (
            <div className="function-view-placeholder">
              {loading ? (
                <span className="spinner" aria-hidden />
              ) : (
                'No source available — this node has no recorded range.'
              )}
            </div>
          )}
        </section>
        <ColumnDivider index={1} resize={resize} />
        <section className="function-view-panel">
          <h3>Uses{detail ? ` (${detail.metrics.outCount})` : ''}</h3>
          {detail ? (
            <CallLinkList links={detail.outgoing} empty="This symbol uses nothing indexed" />
          ) : (
            <div className="function-view-placeholder">
              {loading ? <span className="spinner" aria-hidden /> : '—'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
