import {
  compendiumIdentifiers,
  compendiumNameVariants,
  normaliseCompendiumName,
  type CompendiumRow,
  type CompendiumSheet,
} from '@clarity/core';
const indexes = new WeakMap<
  CompendiumSheet,
  {
    rows: CompendiumRow[];
    details: Map<CompendiumRow, { name: string; identifiers: string[]; search: string }>;
  }
>();
export function pickerRowIndex(tab: CompendiumSheet) {
  let index = indexes.get(tab);
  if (!index) {
    index = {
      rows: [...tab.rows].sort((a, b) => a.name.localeCompare(b.name) || a.rowIndex - b.rowIndex),
      details: new Map(
        tab.rows.map((row) => [
          row,
          {
            name: normaliseCompendiumName(row.name),
            identifiers: compendiumIdentifiers(row.name).map(normaliseCompendiumName),
            search: normaliseCompendiumName(`${row.name} ${row.section ?? ''}`),
          },
        ]),
      ),
    };
    indexes.set(tab, index);
  }
  return index;
}
export function pickerRows(
  tab: CompendiumSheet | undefined,
  category: string,
  query: string,
  section: string,
) {
  const exact = new Set<CompendiumRow>();
  if (!tab) return { rows: [], exact };
  const index = pickerRowIndex(tab);
  const searches = compendiumNameVariants(category, query).map(normaliseCompendiumName);
  const hits: CompendiumRow[] = [];
  const rest: CompendiumRow[] = [];
  for (const row of index.rows) {
    if (section && row.section !== section) continue;
    const detail = index.details.get(row)!;
    if (query.trim() && !searches.some((search) => detail.search.includes(search))) continue;
    if (query.trim() && detail.identifiers.some((identifier) => searches.includes(identifier))) {
      exact.add(row);
      hits.push(row);
    } else rest.push(row);
  }
  return { rows: [...hits, ...rest], exact };
}
