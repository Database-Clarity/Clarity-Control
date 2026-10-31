import {
  normaliseRuns,
  type CompendiumCell,
  type CompendiumCellOffset,
  type CompendiumGridCell,
  type CompendiumPosition,
  type CompendiumSheet,
} from './types.js';

export function compendiumCellAt(
  sheet: CompendiumSheet,
  position: CompendiumPosition,
): CompendiumGridCell | undefined {
  return sheet.grid?.find(
    (entry) =>
      position.row >= entry.row &&
      position.row < entry.row + (entry.rowSpan ?? 1) &&
      position.col >= entry.col &&
      position.col < entry.col + (entry.colSpan ?? 1),
  );
}

export function selectCompendiumCells(
  sheet: CompendiumSheet,
  anchor: CompendiumPosition,
  offsets: CompendiumCellOffset[],
): CompendiumCell | undefined {
  if (!offsets.length) return undefined;
  const cells = offsets.map(({ dRow, dCol }) =>
    compendiumCellAt(sheet, { row: anchor.row + dRow, col: anchor.col + dCol }),
  );
  if (cells.some((entry) => !entry?.cell.plain.trim()) || new Set(cells).size !== cells.length)
    return undefined;
  return normaliseRuns(
    cells.flatMap((entry, index) => [...(index ? [{ text: '\n' }] : []), ...entry!.cell.runs]),
  );
}
