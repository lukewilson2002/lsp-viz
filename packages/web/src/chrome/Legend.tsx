/**
 * Collapsible legend (bottom-left): node kinds + edge styles. Collapsed to a
 * small "?" chip by default; the open state persists in localStorage.
 */

import type { NodeKind } from '@lsp-viz/core';
import { useState } from 'react';
import { kindGlyph } from '../canvas/glyphs';

const STORAGE_KEY = 'lsp-viz:legend-open';

const NODE_ROWS: ReadonlyArray<[NodeKind, string]> = [
  ['package', 'package / workspace'],
  ['directory', 'directory'],
  ['file', 'file'],
  ['function', 'function / method'],
  ['class', 'class'],
  ['interface', 'interface'],
  ['type', 'type'],
  ['variable', 'variable'],
];

function EdgeSample({ dash, dim }: { dash?: string; dim?: boolean }) {
  return (
    <svg className="legend-edge-sample" viewBox="0 0 40 8" width="40" height="8" aria-hidden>
      <line
        x1="1"
        y1="4"
        x2="39"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={dash}
        opacity={dim ? 0.55 : 1}
      />
    </svg>
  );
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Legend() {
  const [open, setOpen] = useState<boolean>(readOpen);

  const toggle = (): void => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // private mode etc. — state just won't persist
      }
      return next;
    });
  };

  if (!open) {
    return (
      <button className="legend-chip" onClick={toggle} title="Legend" aria-label="Open legend">
        ?
      </button>
    );
  }

  return (
    <div className="legend-card" aria-label="Legend">
      <div className="legend-head">
        <span>Legend</span>
        <button onClick={toggle} title="Collapse legend" aria-label="Close legend">
          ×
        </button>
      </div>
      <div className="legend-section">Nodes</div>
      {NODE_ROWS.map(([kind, label]) => (
        <div className="legend-row" key={kind}>
          <span className={`kind-glyph kind-glyph--${kind}`} aria-hidden>
            {kindGlyph(kind)}
          </span>
          <span>{label}</span>
        </div>
      ))}
      <div className="legend-row">
        <span className="legend-portal-sample" aria-hidden />
        <span>portal (symbol in another file)</span>
      </div>
      <div className="legend-row">
        <span className="legend-cluster-sample" aria-hidden>
          +N
        </span>
        <span>collapsed “+N more” group</span>
      </div>
      <div className="legend-section">Edges</div>
      <div className="legend-row">
        <EdgeSample />
        <span>calls</span>
      </div>
      <div className="legend-row">
        <EdgeSample dash="7 5" />
        <span>imports</span>
      </div>
      <div className="legend-row">
        <EdgeSample dash="2 4" />
        <span>references</span>
      </div>
      <div className="legend-row">
        <EdgeSample dash="4 4" dim />
        <span>portal (cross-file link)</span>
      </div>
    </div>
  );
}
