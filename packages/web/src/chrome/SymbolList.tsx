/**
 * The Details tab's declaration list, from GET /api/symbols/:id.
 *
 * When a container is selected the list is grouped by declaring file, and the
 * groups read as a shallow tree: a file row leads with its NAME beside its
 * glyph and trails the directory it sits in, dimmed, and the declarations sit
 * indented beneath it behind a guide rail. Each group collapses, which is what
 * makes a package of two hundred declarations scannable.
 *
 * Within a group rows stay FLAT and in source order; a method inside a class is
 * an indent derived from `entry.depth`, not a nested component, which keeps the
 * server's cap deterministic and the list scannable.
 *
 * Every row navigates: leaf symbols land on their L5 view, classes/interfaces
 * on their own L4 view. The chevron is a sibling button rather than one nested
 * inside the file row — a button inside a button is invalid, and the two do
 * genuinely different things. The lowercase kind sits at the right of each row
 * rather than in a pill: two hundred pills is noise, and the point is only to
 * answer "is this a function or a const".
 */

import type { SymbolFileGroup, SymbolsResponse } from '@lsp-viz/core';
import { useState } from 'react';
import { kindGlyph } from '../canvas/glyphs';
import { useAppStore } from '../state/store';

/** Indent per nesting level within a file (a method inside a class). */
const DEPTH_INDENT = 12;

export function SymbolList({
  response,
  showGroupHeaders,
  empty,
}: {
  response: SymbolsResponse;
  /** False for a file/symbol scope, where the single group IS the selection. */
  showGroupHeaders: boolean;
  empty: string;
}) {
  const navigateToNode = useAppStore((s) => s.navigateToNode);
  // Collapsed groups, by file id — everything starts open, and the state is
  // per-selection by design (DetailsPane is keyed by node, so it resets when
  // you select something else rather than following you around).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (fileId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  if (response.groups.length === 0) {
    return <div className="detail-empty">{empty}</div>;
  }

  return (
    <>
      {response.groups.map((group) => {
        const open = !showGroupHeaders || !collapsed.has(group.fileId);
        return (
          <div className="detail-symbol-group" key={group.fileId}>
            {showGroupHeaders ? (
              <div className="detail-symbol-group-head">
                <button
                  className="detail-symbol-group-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${group.path}`}
                  onClick={() => toggle(group.fileId)}
                >
                  <span aria-hidden>{open ? '▾' : '▸'}</span>
                </button>
                <button
                  className="detail-symbol-group-open"
                  onClick={() => void navigateToNode(group.fileId)}
                  title={group.path}
                >
                  <span className="kind-glyph kind-glyph--file" aria-hidden>
                    {kindGlyph('file')}
                  </span>
                  <span className="detail-symbol-group-name">{fileName(group)}</span>
                  {fileDir(group) !== '' ? (
                    <span className="detail-symbol-group-path">{fileDir(group)}</span>
                  ) : null}
                </button>
              </div>
            ) : null}
            {open ? (
              <div className={showGroupHeaders ? 'detail-symbol-children' : undefined}>
                {group.symbols.map((entry) => (
                  <button
                    key={entry.id}
                    className="detail-symbol-row"
                    style={{ paddingLeft: 6 + entry.depth * DEPTH_INDENT }}
                    onClick={() => void navigateToNode(entry.id)}
                    title={`${entry.name} — ${entry.kind}`}
                  >
                    <span className={`kind-glyph kind-glyph--${entry.kind}`} aria-hidden>
                      {kindGlyph(entry.kind)}
                    </span>
                    <span className="detail-symbol-name">{entry.name}</span>
                    <span className="detail-symbol-kind">{entry.kind}</span>
                  </button>
                ))}
                {group.omitted > 0 ? (
                  <div className="detail-empty">+{group.omitted} more in this file</div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {response.truncated ? (
        <div className="detail-empty">
          Showing the first {countShown(response)} — the rest were trimmed.
        </div>
      ) : null}
    </>
  );
}

/**
 * A file row leads with its NAME, like a tree row — the directory it sits in
 * trails behind it, dimmed. Splitting them is what keeps the row readable: the
 * whole relative path right-aligned left the row empty except for its glyph,
 * with the one word that identifies the file pushed to the far edge.
 */
function fileName(group: SymbolFileGroup): string {
  const relative = group.relativePath === '' ? group.name : group.relativePath;
  return relative.slice(relative.lastIndexOf('/') + 1);
}

/** The directory part of {@link fileName}'s path, '' when the file is at root. */
function fileDir(group: SymbolFileGroup): string {
  const relative = group.relativePath === '' ? group.name : group.relativePath;
  const cut = relative.lastIndexOf('/');
  return cut === -1 ? '' : relative.slice(0, cut);
}

function countShown(response: SymbolsResponse): number {
  let total = 0;
  for (const group of response.groups) total += group.symbols.length;
  return total;
}
