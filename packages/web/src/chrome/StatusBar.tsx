/**
 * Bottom status bar. While indexing: live WS progress (phase, files x/y,
 * current file, symbol/edge counts). Idle: meta stats + indexedAt + a
 * Re-index button (disabled while a run is active).
 */

import type { IndexPhase } from '@lsp-viz/core';
import { useState } from 'react';
import { ApiError, startIndex } from '../api/client';
import { useAppStore } from '../state/store';

const PHASE_LABEL: Record<IndexPhase, string> = {
  structural: 'structural scan',
  semantic: 'semantic analysis',
  aggregate: 'aggregating',
};

/** "packages/very/long/path/file.ts" → "packages/ve…/file.ts" style. */
function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function formatIndexedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function StatusBar() {
  const meta = useAppStore((s) => s.meta);
  const progress = useAppStore((s) => s.indexProgress);
  const indexError = useAppStore((s) => s.indexError);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const indexing = progress !== null || (meta?.indexing ?? false);

  const onReindex = (): void => {
    setRequesting(true);
    setRequestError(null);
    void startIndex({ full: false })
      .catch((err: unknown) => {
        // 409 = a run is already active — the WS stream will reflect it.
        if (!(err instanceof ApiError && err.status === 409)) {
          setRequestError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => setRequesting(false));
  };

  return (
    <footer className="statusbar">
      <span className="statusbar-repo">{meta ? meta.repoName : '—'}</span>
      {progress ? (
        <>
          <span className="statusbar-indexing">
            <span className="spinner" aria-hidden />
            {PHASE_LABEL[progress.phase]} · files {progress.filesDone}/{progress.filesTotal}
          </span>
          {progress.currentFile !== null ? (
            <span className="statusbar-file" title={progress.currentFile}>
              {truncateMiddle(progress.currentFile, 48)}
            </span>
          ) : null}
          <span>
            {progress.symbols !== null ? `${progress.symbols} symbols` : ''}
            {progress.symbols !== null && progress.callEdges !== null ? ' · ' : ''}
            {progress.callEdges !== null ? `${progress.callEdges} call edges` : ''}
          </span>
        </>
      ) : (
        <>
          <span>
            {meta
              ? `${meta.stats.files} files · ${meta.stats.nodes} nodes · ${meta.stats.edges} edges`
              : ''}
          </span>
          <span>
            {indexing
              ? 'indexing…'
              : meta?.indexedAt
                ? `indexed ${formatIndexedAt(meta.indexedAt)}`
                : 'not indexed'}
          </span>
        </>
      )}
      {indexError !== null || requestError !== null ? (
        <span className="statusbar-error" title={indexError ?? requestError ?? ''}>
          {truncateMiddle(indexError ?? requestError ?? '', 60)}
        </span>
      ) : null}
      <span className="statusbar-spacer" />
      <button
        className="statusbar-reindex"
        onClick={onReindex}
        disabled={indexing || requesting}
        title="Re-index (diff by file mtime)"
      >
        Re-index
      </button>
    </footer>
  );
}
