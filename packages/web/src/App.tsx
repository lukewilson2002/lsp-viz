import { useEffect } from 'react';
import { subscribeIndexEvents } from './api/client';
import { GraphCanvas } from './canvas/GraphCanvas';
import { Breadcrumb } from './chrome/Breadcrumb';
import { Legend } from './chrome/Legend';
import { Sidebar } from './chrome/Sidebar';
import { SearchPalette } from './chrome/SearchPalette';
import { StatusBar } from './chrome/StatusBar';
import { ViewKind } from './chrome/ViewKind';
import { useGlobalKeys } from './keys';
import { selectTopEntry, useAppStore } from './state/store';
import { FunctionView } from './views/FunctionView';

export function App() {
  const bootState = useAppStore((s) => s.bootState);
  const bootError = useAppStore((s) => s.bootError);
  const initialize = useAppStore((s) => s.initialize);
  const top = useAppStore(selectTopEntry);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Live index progress; the store handles reconnect-driven refetches.
  useEffect(
    () => subscribeIndexEvents((msg) => useAppStore.getState().handleWsMessage(msg)),
    [],
  );

  useGlobalKeys();

  if (bootState === 'error') {
    return (
      <div className="app-boot app-boot--error">
        <span>Failed to reach the lsp-viz server: {bootError}</span>
      </div>
    );
  }

  if (bootState !== 'ready' || !top) {
    return (
      <div className="app-boot">
        <span className="spinner" aria-hidden />
        <span>Connecting…</span>
      </div>
    );
  }

  const isL5 = top.level === 5;

  return (
    <div className="app">
      <Breadcrumb />
      <main className="app-main">
        {/* Keyed wrapper: every view change re-runs the ~200ms enter animation.
            Canvas views leave room for the always-visible sidebar. */}
        <div className={`view-anim${isL5 ? '' : ' view-anim--canvas'}`} key={top.nodeId}>
          {isL5 ? <FunctionView /> : <GraphCanvas />}
        </div>
        {!isL5 ? <ViewKind /> : null}
        {!isL5 ? <Legend /> : null}
        {!isL5 ? <Sidebar /> : null}
      </main>
      <StatusBar />
      <SearchPalette />
    </div>
  );
}
