/**
 * JSX fixture. Its whole job is to be MISPARSED if the indexer opens a `.tsx`
 * file with the wrong LSP languageId: as plain `typescript`, tsserver reads
 * `<span className="glyph">{glyph(kind)}</span>` as a type assertion applied to
 * an object literal, and documentSymbol then reports `glyph` as a file-level
 * `method` and truncates `Row`'s range at the first `<`.
 */

function glyph(kind: string): string {
  return kind === 'file' ? '#' : '*';
}

export function Row({ kind, label }: { kind: string; label: string }): JSX.Element {
  return (
    <div className="row">
      <span className="glyph">{glyph(kind)}</span>
      <span className="label">{label}</span>
    </div>
  );
}
