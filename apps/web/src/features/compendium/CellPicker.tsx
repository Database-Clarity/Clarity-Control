import { useState } from 'react';
import {
  compendiumCellAt,
  selectCompendiumCells,
  normaliseCompendiumName,
  type CompendiumSheet,
  type CompendiumRow,
  type CompendiumPosition,
  type CompendiumCellOffset,
  type CompendiumMatch,
  type CompendiumData,
} from '@clarity/core';
import { confirmCompendiumSelection } from './selection';
import { RichCell } from './RichCell';
import styles from './Compendium.module.scss';

export function CellPicker({
  tab,
  data,
  initial,
  onChoose,
  readOnly = false,
}: {
  tab: CompendiumSheet;
  data: CompendiumData;
  initial?: CompendiumRow;
  readOnly?: boolean;
  onChoose(match: CompendiumMatch): void;
}) {
  const [anchor, setAnchor] = useState<CompendiumPosition | undefined>(initial?.anchor);
  const [query, setQuery] = useState('');
  const [offsets, setOffsets] = useState<CompendiumCellOffset[]>([]);
  const anchorCell = anchor && compendiumCellAt(tab, anchor);
  const row =
    anchor &&
    (tab.rows.find(
      (entry) => entry.anchor?.row === anchor.row && entry.anchor?.col === anchor.col,
    ) ??
      (anchorCell
        ? {
            name: anchorCell.cell.plain.trim(),
            nameNorm: normaliseCompendiumName(anchorCell.cell.plain.trim()),
            rowIndex: anchor.row,
            anchor,
            cell: anchorCell.cell,
          }
        : undefined));
  const preview = anchor && selectCompendiumCells(tab, anchor, offsets);
  const selection =
    preview && row ? { tab, row: { ...row, cell: preview }, cells: offsets } : undefined;
  const accepted = selection && confirmCompendiumSelection(selection, data);
  if (!tab.grid)
    return <p>This dataset has no sheet grid. Refresh the dataset to pick description cells.</p>;
  const hits = query.trim()
    ? tab.grid.filter((entry) =>
        entry.cell.plain.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];
  const firstRow = Math.max(1, (anchor?.row ?? 1) - 8);
  const lastRow = (anchor?.row ?? 1) + 8;
  const columns = Math.max(1, ...tab.grid.map((entry) => entry.col + (entry.colSpan ?? 1)));
  function pickAnchor(position: CompendiumPosition) {
    setAnchor(position);
    setOffsets([]);
  }
  return (
    <section aria-label="Pick description cells">
      <h3>Pick description cells</h3>
      <label>
        Search all sheet text for a name anchor{' '}
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className={styles.rows}>
        {hits.slice(0, 100).map((entry) => (
          <li key={`${entry.row}:${entry.col}`}>
            <button type="button" onClick={() => pickAnchor({ row: entry.row, col: entry.col })}>
              Use anchor at row {entry.row}, column {entry.col + 1}:{' '}
              {entry.cell.plain.slice(0, 160)}
            </button>
          </li>
        ))}
      </ul>
      {hits.length > 100 && <p>Showing 100 of {hits.length} matches; refine the search.</p>}
      {anchor && (
        <>
          <p>
            Name anchor: {row?.name}. Select description cells in reading order; click again to
            remove. Numbers show selection order.
          </p>
          <div
            className={styles.sheetScroll}
            role="region"
            aria-label="Sheet cells around the name anchor"
            tabIndex={0}
          >
            <table className={styles.sheet}>
              <tbody>
                {Array.from({ length: lastRow - firstRow + 1 }, (_, index) => firstRow + index).map(
                  (rowNumber) => (
                    <tr key={rowNumber}>
                      <th scope="row">{rowNumber}</th>
                      {Array.from({ length: columns }, (_, col) => {
                        const entry = compendiumCellAt(tab, { row: rowNumber, col });
                        if (
                          entry &&
                          (col !== entry.col || rowNumber !== Math.max(firstRow, entry.row))
                        )
                          return null;
                        if (!entry) return <td key={col} />;
                        const isAnchor = entry === anchorCell;
                        const offset = {
                          dRow: entry.row - anchor.row,
                          dCol: entry.col - anchor.col,
                        };
                        const selected = offsets.findIndex(
                          (value) => value.dRow === offset.dRow && value.dCol === offset.dCol,
                        );
                        return (
                          <td
                            key={col}
                            colSpan={entry.colSpan}
                            rowSpan={Math.min(
                              entry.row + (entry.rowSpan ?? 1) - rowNumber,
                              lastRow - rowNumber + 1,
                            )}
                            data-anchor={isAnchor}
                          >
                            <button
                              type="button"
                              aria-label={`Row ${entry.row}, column ${col + 1}: ${entry.cell.plain}`}
                              aria-pressed={selected >= 0}
                              disabled={selected < 0 && offsets.length >= 256}
                              onClick={() =>
                                setOffsets(
                                  selected >= 0
                                    ? offsets.filter((_, index) => index !== selected)
                                    : [...offsets, offset],
                                )
                              }
                            >
                              {selected >= 0 && <strong>({selected + 1}) </strong>}
                              <RichCell cell={entry.cell} links={false} />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p>{offsets.length} selected</p>
          {preview && (
            <div className={styles.cell}>
              <RichCell cell={preview} />
            </div>
          )}
          {selection && !accepted && (
            <p role="alert">
              This anchor cannot uniquely identify the selected cells. Duplicate anchor text is
              ambiguous; choose a nearby unique anchor using the search, then select the description
              cells again.
            </p>
          )}
          <button type="button" onClick={() => setOffsets([])}>
            Clear selection
          </button>{' '}
          <button
            type="button"
            disabled={readOnly || !accepted}
            onClick={() => {
              if (accepted && selection) onChoose(selection);
            }}
          >
            Use selected cells (local draft)
          </button>
        </>
      )}
      {!anchor && <p>Search for the item name, then choose its anchor cell.</p>}
    </section>
  );
}
