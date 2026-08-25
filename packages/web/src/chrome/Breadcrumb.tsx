import { useEffect } from 'react';
import { kindGlyph } from '../canvas/glyphs';
import { isEditableTarget, isMacPlatform } from '../keys';
import { useAppStore } from '../state/store';

/** Top bar: Back button + one clickable crumb per stack entry + search. */
export function Breadcrumb() {
  const stack = useAppStore((s) => s.stack);
  const goBack = useAppStore((s) => s.goBack);
  const goToDepth = useAppStore((s) => s.goToDepth);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  // Backspace = Back — never when an input has focus or the palette is open
  // (Tab can move palette focus off its input onto a result button).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (useAppStore.getState().paletteOpen) return;
      event.preventDefault();
      useAppStore.getState().goBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <nav className="breadcrumb" aria-label="Navigation stack">
      <button
        className="breadcrumb-back"
        onClick={goBack}
        disabled={stack.length <= 1}
        title="Back (Backspace)"
      >
        ← Back
      </button>
      {stack.map((entry, index) => {
        const isCurrent = index === stack.length - 1;
        return (
          <span key={`${index}-${entry.nodeId}`} style={{ display: 'contents' }}>
            {index > 0 ? (
              <span className="breadcrumb-sep" aria-hidden>
                ›
              </span>
            ) : null}
            <button
              className={`breadcrumb-crumb${isCurrent ? ' breadcrumb-crumb--current' : ''}`}
              onClick={() => {
                if (!isCurrent) goToDepth(index + 1);
              }}
              title={entry.name}
            >
              <span className="kind-glyph" aria-hidden>
                {kindGlyph(entry.kind)}
              </span>
              <span className="crumb-name">{entry.name}</span>
            </button>
          </span>
        );
      })}
      <span className="breadcrumb-spacer" />
      <button
        className="breadcrumb-search"
        onClick={() => setPaletteOpen(true)}
        title="Search symbols"
      >
        <span aria-hidden>⌕</span> Search
        <kbd>{isMacPlatform() ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
    </nav>
  );
}
