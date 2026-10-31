import {
  resolveCompendiumLink,
  snapshotCompendium,
  sameCell,
  type CompendiumData,
  type CompendiumMatch,
} from '@clarity/core';

// Used by preview and every manual confirmation before creating a local draft.
export function confirmCompendiumSelection(match: CompendiumMatch, data: CompendiumData) {
  const resolved = resolveCompendiumLink(snapshotCompendium(match), data);
  if (!('row' in resolved)) return undefined;
  if (
    match.cells &&
    (resolved.tab.gid !== match.tab.gid ||
      resolved.row.anchor?.row !== match.row.anchor?.row ||
      resolved.row.anchor?.col !== match.row.anchor?.col ||
      !sameCell(resolved.row.cell, match.row.cell))
  )
    return undefined;
  return snapshotCompendium(resolved);
}
