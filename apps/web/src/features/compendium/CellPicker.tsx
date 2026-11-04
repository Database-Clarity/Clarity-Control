import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
  type CompendiumGridCell,
} from '@clarity/core';
import { confirmCompendiumSelection } from './selection';
import { Multiline, RichCell } from './RichCell';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './Compendium.module.scss';

export const CellPicker = memo(function CellPicker({
  tab,
  data,
  initial,
  onChoose,
  readOnly = false,
  referenceOnly = false,
}: {
  tab: CompendiumSheet;
  data: CompendiumData;
  initial?: CompendiumRow;
  readOnly?: boolean;
  referenceOnly?: boolean;
  onChoose(match: CompendiumMatch): void;
}) {
  const phone = useMedia(phoneQuery);
  const list = useRef<HTMLDivElement>(null);
  const returnCell = useRef('');
  const [detail, setDetail] = useState<{ row: number; col: number }>();
  useEffect(() => {
    if (detail) list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else
      list.current
        ?.querySelector<HTMLButtonElement>(`[data-cell-address="${returnCell.current}"]`)
        ?.focus();
  }, [detail, phone]);
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
  const firstRow = Math.max(1, (anchor?.row ?? 1) - 8);
  const lastRow = (anchor?.row ?? 1) + 8;
  const columns = useMemo(
    () => Math.max(1, ...(tab.grid ?? []).map((entry) => entry.col + (entry.colSpan ?? 1))),
    [tab],
  );
  const visibleCells = useMemo(() => {
    const cells = new Map<string, CompendiumGridCell>();
    if (phone) return cells;
    // One sheet scan, preserving compendiumCellAt's first-cell precedence and merged spans.
    // Avoid scanning the entire grid again for every coordinate in the visible window.
    for (const entry of tab.grid ?? []) {
      const start = Math.max(firstRow, entry.row);
      const end = Math.min(lastRow, entry.row + (entry.rowSpan ?? 1) - 1);
      for (let row = start; row <= end; row++) {
        for (let col = entry.col; col < entry.col + (entry.colSpan ?? 1); col++) {
          const key = `${row}:${col}`;
          if (!cells.has(key)) cells.set(key, entry);
        }
      }
    }
    return cells;
  }, [tab, firstRow, lastRow, phone]);
  if (!tab.grid)
    return <p>This dataset has no sheet grid. Refresh the dataset to pick description cells.</p>;
  const hits = query.trim()
    ? tab.grid.filter((entry) =>
        entry.cell.plain.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];
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
              <Multiline>{entry.cell.plain.slice(0, 160)}</Multiline>
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
          {phone && (
            <div ref={list} className={styles.phoneCells} aria-label="Description cell list">
              {detail ? (
                <section aria-label="Cell detail">
                  <button type="button" onClick={() => setDetail(undefined)}>
                    Back to cells
                  </button>
                  <p>
                    Row {detail.row}, column {detail.col + 1}
                  </p>
                  {(() => {
                    const entry = compendiumCellAt(tab, detail);
                    if (!entry) return null;
                    const offset = { dRow: entry.row - anchor.row, dCol: entry.col - anchor.col };
                    const selected = offsets.findIndex(
                      (value) => value.dRow === offset.dRow && value.dCol === offset.dCol,
                    );
                    return (
                      <>
                        <RichCell cell={entry.cell} />
                        <button
                          type="button"
                          aria-pressed={selected >= 0}
                          disabled={selected < 0 && offsets.length >= 256}
                          onClick={() =>
                            setOffsets(
                              selected >= 0
                                ? offsets.filter((_, i) => i !== selected)
                                : [...offsets, offset],
                            )
                          }
                        >
                          {selected >= 0 ? `Remove cell (${selected + 1})` : 'Select cell next'}
                        </button>
                      </>
                    );
                  })()}
                </section>
              ) : (
                tab.grid
                  .filter((entry) => entry.row >= firstRow && entry.row <= lastRow)
                  .map((entry) => {
                    const selected = offsets.findIndex(
                      (value) =>
                        value.dRow === entry.row - anchor.row &&
                        value.dCol === entry.col - anchor.col,
                    );
                    return (
                      <button
                        type="button"
                        key={`${entry.row}:${entry.col}`}
                        data-cell-address={`${entry.row}:${entry.col}`}
                        onClick={() => {
                          returnCell.current = `${entry.row}:${entry.col}`;
                          setDetail({ row: entry.row, col: entry.col });
                        }}
                      >
                        Row {entry.row}, column {entry.col + 1}
                        {selected >= 0 ? ` (${selected + 1})` : ''}:{' '}
                        <Multiline>{entry.cell.plain.slice(0, 160)}</Multiline>
                      </button>
                    );
                  })
              )}
            </div>
          )}
          {!phone && (
            <div
              className={styles.sheetScroll}
              role="region"
              aria-label="Sheet cells around the name anchor"
              tabIndex={0}
            >
              <table
                className={styles.sheet}
                style={{ tableLayout: 'fixed', width: `${5 + columns * 14}rem` }}
              >
                <colgroup>
                  <col style={{ width: '5rem' }} />
                  <col span={columns} style={{ width: '14rem' }} />
                </colgroup>
                <tbody>
                  {Array.from(
                    { length: lastRow - firstRow + 1 },
                    (_, index) => firstRow + index,
                  ).map((rowNumber) => (
                    <tr key={rowNumber}>
                      <th scope="row">{rowNumber}</th>
                      {Array.from({ length: columns }, (_, col) => {
                        const entry = visibleCells.get(`${rowNumber}:${col}`);
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            {referenceOnly
              ? 'Use selected cells (local reference)'
              : 'Use selected cells (local draft)'}
          </button>
        </>
      )}
      {!anchor && <p>Search for the item name, then choose its anchor cell.</p>}
    </section>
  );
});
