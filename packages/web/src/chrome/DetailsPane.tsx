/**
 * Details tab — everything the app knows about the current selection, in one
 * scrollable column: identity, source, declarations, then the full link lists.
 *
 * The division of labour with the node cards is deliberate. Cards carry
 * high-level counts sized to fit an ELK-computed box; this pane is the
 * uncapped, unclamped surface, so nothing here is truncated, hidden behind a
 * hover, or capped at N rows. Source comes first (it is what the user asked to
 * see), symbols next, links last because they are the least scannable.
 *
 * There is deliberately NO directory/file listing here — that is the Files
 * tab's job. This tab is only semantics.
 */

import type { GraphNode, NodeDetailResponse } from '@lsp-viz/core';
import { useEffect, useState } from 'react';
import { kindGlyph } from '../canvas/glyphs';
import { SourceView } from '../code/SourceView';
import { useCodeLinks } from '../code/useCodeLinks';
import { isContainerKind } from '../levels';
import { useAppStore } from '../state/store';
import { CallLinkList } from './CallList';
import { DetailSection } from './DetailSection';
import { SymbolList } from './SymbolList';

/** How the symbol section is labelled and grouped, per selected kind. */
type SymbolMode = { label: string; groups: boolean } | null;

function symbolMode(node: GraphNode, childCount: number): SymbolMode {
  if (isContainerKind(node.kind)) return { label: 'Symbols', groups: true };
  if (node.kind === 'file') return { label: 'Declarations', groups: false };
  if (node.kind === 'class' || node.kind === 'interface') return { label: 'Members', groups: false };
  // A leaf symbol with nothing nested inside it would render an empty section
  // on every selection — drop it instead.
  return childCount > 0 ? { label: 'Declarations', groups: false } : null;
}

function symbolsEmptyText(node: GraphNode, indexing: boolean): string {
  if (isContainerKind(node.kind)) {
    return indexing
      ? 'Indexing — symbols appear as files are analyzed.'
      : 'No symbols indexed here yet.';
  }
  if (node.kind === 'file') return 'No declarations indexed in this file.';
  if (node.kind === 'class' || node.kind === 'interface') return 'No members indexed.';
  return 'No nested declarations.';
}

/**
 * Wording only. The server answers every kind: containers get aggregate
 * roll-ups, files their imports, symbols their calls — and a symbol with
 * members (a class) gets its members' calls rolled up onto it, so an empty
 * list here really does mean nothing connects.
 *
 * Symbol wording stays link-neutral ("uses", not "calls"): these lists carry
 * `references`, `extends` and `implements` alongside `calls`, and a constant
 * that nothing CALLS is still used by the function that reads it.
 */
function linkEmptyText(node: GraphNode, direction: 'incoming' | 'outgoing'): string {
  if (node.kind === 'class' || node.kind === 'interface') {
    return direction === 'incoming'
      ? `Nothing uses this ${node.kind} or its members.`
      : `Neither this ${node.kind} nor its members use anything indexed.`;
  }
  if (isContainerKind(node.kind)) {
    return direction === 'incoming' ? 'No inbound dependencies.' : 'No outbound dependencies.';
  }
  if (node.kind === 'file') {
    return direction === 'incoming'
      ? 'No file imports this.'
      : 'This file imports nothing indexed.';
  }
  return direction === 'incoming' ? 'Nothing uses this.' : 'This uses nothing indexed.';
}

function metricsLine(detail: NodeDetailResponse): string {
  const attrs = detail.node.attrs;
  const parts: string[] = [];
  if (attrs?.loc !== undefined) parts.push(`${attrs.loc} loc`);
  if (attrs?.exportCount !== undefined) {
    parts.push(`${attrs.exportCount} export${attrs.exportCount === 1 ? '' : 's'}`);
  }
  if (detail.metrics.childCount > 0) {
    parts.push(`${detail.metrics.childCount} child${detail.metrics.childCount === 1 ? '' : 'ren'}`);
  }
  if (attrs?.entry === true) parts.push('entry point');
  const names = attrs?.exportedNames ?? [];
  if (names.length > 0) parts.push(`exports: ${names.join(', ')}`);
  // attrs.symbolCount is deliberately absent: on containers it counts every
  // descendant NODE (dirs + files + symbols), so printing it as a symbol count
  // would lie. The truthful number is the Symbols section's chip.
  return parts.join(' · ');
}

export function DetailsPane({ nodeId }: { nodeId: string }) {
  const ensureNodeDetail = useAppStore((s) => s.ensureNodeDetail);
  const ensureSource = useAppStore((s) => s.ensureSource);
  const ensureSymbols = useAppStore((s) => s.ensureSymbols);
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  const select = useAppStore((s) => s.select);
  const detail = useAppStore((s) => s.nodeDetails[nodeId] ?? null);
  const source = useAppStore((s) => s.sources[nodeId] ?? null);
  const meta = useAppStore((s) => s.meta);
  const dataEpoch = useAppStore((s) => s.dataEpoch);

  const [missing, setMissing] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);

  // Re-runs on a new selection AND on every invalidate(): a re-index empties
  // all three caches this pane reads, and without dataEpoch the pane would sit
  // on a spinner until the user selected some OTHER node.
  useEffect(() => {
    let cancelled = false;
    setMissing(false);
    setSourceFailed(false);
    void ensureNodeDetail(nodeId).then((loaded) => {
      if (cancelled) return;
      if (loaded === null) {
        setMissing(true);
        return;
      }
      // Containers have no file behind them — skip the request rather than
      // provoking a 404 on every selection.
      if (!isContainerKind(loaded.node.kind)) {
        void ensureSource(nodeId).then((src) => {
          if (!cancelled && src === null) setSourceFailed(true);
        });
      }
      // Only fetch declarations for a scope that will actually render a list.
      if (symbolMode(loaded.node, loaded.metrics.childCount) !== null) {
        void ensureSymbols(nodeId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, dataEpoch, ensureNodeDetail, ensureSource, ensureSymbols]);

  const links = useCodeLinks(nodeId);

  if (missing) {
    return (
      <div className="detail-missing">
        <span>This node is no longer in the index.</span>
        <button className="detail-missing-action" onClick={() => select(null)}>
          Clear the selection
        </button>
      </div>
    );
  }

  const node = detail?.node ?? null;

  return (
    <div className="sidebar-details">
      <header className="detail-identity">
        <div className="detail-identity-row">
          {node ? (
            <>
              <span className={`kind-glyph kind-glyph--${node.kind}`} aria-hidden>
                {kindGlyph(node.kind)}
              </span>
              <span className="detail-name">{node.name}</span>
              <span className="kind-badge">{node.kind}</span>
              <button
                className="detail-open"
                onClick={() => void navigateToNode(nodeId)}
                title="Open this node's view"
              >
                Open ↗
              </button>
            </>
          ) : (
            <span className="spinner" aria-hidden />
          )}
        </div>
        {node ? (
          <div className="detail-path">{node.path === '' ? (meta?.repoRoot ?? '/') : node.path}</div>
        ) : null}
        {detail ? (
          (() => {
            const line = metricsLine(detail);
            return line === '' ? null : <div className="detail-metrics">{line}</div>;
          })()
        ) : null}
        {node?.signature !== undefined && node.signature !== '' ? (
          <div className="detail-signature">{node.signature}</div>
        ) : null}
      </header>

      {node && !isContainerKind(node.kind) ? (
        <DetailSection
          id="source"
          label="Source"
          className="detail-section--source"
          count={source ? `lines ${source.startLine}–${source.endLine}` : undefined}
        >
          {source ? (
            <SourceView
              text={source.text}
              path={source.path}
              language={source.language}
              startLine={source.startLine}
              links={links}
            />
          ) : (
            <div className="sidebar-placeholder">
              {sourceFailed ? (
                'No source on disk for this node.'
              ) : (
                <span className="spinner" aria-hidden />
              )}
            </div>
          )}
        </DetailSection>
      ) : null}

      {node && detail ? <SymbolsSection node={node} detail={detail} /> : null}

      {node && detail ? (
        <>
          <DetailSection id="incoming" label="Incoming" count={String(detail.metrics.inCount)}>
            <CallLinkList links={detail.incoming} empty={linkEmptyText(node, 'incoming')} />
          </DetailSection>
          <DetailSection id="outgoing" label="Outgoing" count={String(detail.metrics.outCount)}>
            <CallLinkList links={detail.outgoing} empty={linkEmptyText(node, 'outgoing')} />
          </DetailSection>
        </>
      ) : null}
    </div>
  );
}

function SymbolsSection({ node, detail }: { node: GraphNode; detail: NodeDetailResponse }) {
  const symbols = useAppStore((s) => s.symbols[node.id] ?? null);
  const indexing = useAppStore((s) => s.meta?.indexing === true);
  const mode = symbolMode(node, detail.metrics.childCount);
  if (mode === null) return null;

  const count =
    symbols === null
      ? undefined
      : mode.groups
        ? `${symbols.totalSymbols} symbols · ${symbols.totalFiles} files`
        : String(symbols.totalSymbols);

  return (
    <DetailSection id="symbols" label={mode.label} count={count}>
      {symbols === null ? (
        <div className="sidebar-placeholder">
          <span className="spinner" aria-hidden />
        </div>
      ) : (
        <SymbolList
          response={symbols}
          showGroupHeaders={mode.groups}
          empty={symbolsEmptyText(node, indexing)}
        />
      )}
    </DetailSection>
  );
}
