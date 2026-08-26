/**
 * L5 — focused leaf-symbol view: inbound links | Shiki-highlighted full source
 * with real line numbers | outbound links. Every row navigates; identifiers the
 * graph can resolve are clickable in the source.
 *
 * The columns are "Used by" / "Uses", not "Callers" / "Callees": these lists
 * carry every symbol-level edge kind, and this view is reached by variables and
 * types too — a constant is REFERENCED by the function whose default parameter
 * reads it, and calling that "Callers" describes the wrong relationship on the
 * very node most likely to be looked at here.
 */

import { kindGlyph } from '../canvas/glyphs';
import { SourceView } from '../code/SourceView';
import { useCodeLinks } from '../code/useCodeLinks';
import { CallLinkList } from '../chrome/CallList';
import { selectTopEntry, useAppStore } from '../state/store';

export function FunctionView() {
  const entry = useAppStore(selectTopEntry);
  const l5 = useAppStore((s) => s.l5);

  const slot = entry && l5?.nodeId === entry.nodeId ? l5 : null;
  const detail = slot?.detail ?? null;
  const source = slot?.source ?? null;
  const loading = slot?.loading ?? true;
  const error = slot?.error ?? null;

  const links = useCodeLinks(entry?.nodeId ?? null);

  if (!entry) return null;

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
      <pre className="function-view-signature">
        {detail?.node.signature ?? (loading ? 'Loading…' : entry.name)}
      </pre>
      <div className="function-view-columns">
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
