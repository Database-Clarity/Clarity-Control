import {
  compendiumCellAt,
  compendiumPreferredTabs,
  compendiumTabs,
  normaliseCompendiumName,
  type CompendiumData,
  type CompendiumRow,
  type CompendiumSheet,
} from '@clarity/core';

// Optional research hints guide navigation only. Confirmation always uses selection.ts.
export interface CompendiumSuggestion {
  gid: string;
  section?: string;
  anchor?: { row: number; col: number };
  rationale: string;
  observedAt?: string;
  fingerprint?: string;
  stale?: boolean;
}
export function suggestionAnchor(
  tab: CompendiumSheet,
  hint: CompendiumSuggestion,
): CompendiumRow | undefined {
  if (!hint.anchor)
    return hint.section ? tab.rows.find((row) => row.section === hint.section) : undefined;
  const parsed = tab.rows.find(
    (row) => row.anchor?.row === hint.anchor!.row && row.anchor?.col === hint.anchor!.col,
  );
  if (parsed) return parsed;
  const entry = compendiumCellAt(tab, hint.anchor);
  if (!entry) return undefined;
  return {
    name: entry.cell.plain.trim(),
    nameNorm: normaliseCompendiumName(entry.cell.plain),
    rowIndex: entry.row,
    anchor: { row: entry.row, col: entry.col },
    cell: entry.cell,
  };
}
export function categorySuggestions(
  data: CompendiumData,
  category: string,
  name: string,
): CompendiumSuggestion[] {
  return compendiumPreferredTabs(category, name).flatMap((gid) => {
    const tab = data.tabs.find((tab) => tab.gid === gid);
    if (!tab) return [];
    const sections = [
      ...new Set(
        tab.rows
          .map((row) => row.section)
          .filter(
            (section) =>
              section &&
              compendiumTabs[gid]?.sectionCategories?.[section] === sectionCategory(category),
          ),
      ),
    ];
    return sections.length
      ? sections.map((section) => ({
          gid,
          section,
          rationale: `The Compendium configuration maps this section to category ${category}. This is a place to look, not a confirmed match.`,
        }))
      : [
          {
            gid,
            rationale: `The category configuration includes ${tab.name}. No specific section is established.`,
          },
        ];
  });
}

// Section categories are the existing resolver's short names.
function sectionCategory(category: string): string {
  if (category.startsWith('weapon-frame')) return 'frame';
  if (category.startsWith('weapon-trait-origin')) return 'origin';
  if (category.startsWith('weapon-trait')) return 'trait';
  if (category === 'weapon-mod') return 'mod';
  return category;
}
