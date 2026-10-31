import hints from './research-hints.json';
import { sourceFingerprint } from './reviewProgress';
import { categorySuggestions, type CompendiumSuggestion } from './suggestions';
import type { CompendiumData } from '@clarity/core';
interface Place {
  gid: string;
  rowKey?: string;
  section?: string;
  rationale: string;
  relation: string;
  fingerprint?: string;
}
interface Entry {
  name: string;
  category: string;
  places: number[];
}
const records: Record<string, Entry> = hints.entries;
const places: Place[] = hints.places;
// Navigation only. Resolve coordinates anew; normal picker validates human selections.
export function researchSuggestions(
  hash: number,
  data: CompendiumData,
  category: string,
  name: string,
): CompendiumSuggestion[] {
  const entry = records[hash];
  if (!entry || entry.name !== name || entry.category !== category)
    return categorySuggestions(data, category, name);
  return entry.places.map((index) => {
    const place = places[index];
    const tab = data.tabs.find((tab) => tab.gid === place.gid);
    const anchors = tab?.grid?.filter((c) => c.cell.plain.trim() === place.rowKey?.trim()) ?? [];
    const anchor = anchors.length === 1 ? anchors[0] : undefined;
    const fingerprint =
      anchor &&
      sourceFingerprint(
        tab!
          .grid!.filter((c) => Math.abs(c.row - anchor.row) <= 8)
          .map((c) => ({ dRow: c.row - anchor.row, col: c.col, cell: c.cell })),
      );
    const stale =
      !!place.rowKey && (!anchor || !place.fingerprint || fingerprint !== place.fingerprint);
    const section = anchor
      ? tab?.rows.find((row) => row.anchor?.row === anchor.row && row.anchor?.col === anchor.col)
          ?.section
      : tab?.rows.some((row) => row.section === place.section)
        ? place.section
        : undefined;
    return {
      gid: place.gid,
      section,
      ...(anchor ? { anchor: { row: anchor.row, col: anchor.col } } : {}),
      rationale: `${place.relation === 'equivalent' ? 'Whole source proposal; confirm scope' : place.relation}. ${place.rationale} Observed ${hints.observedAt}. ${stale ? 'Warning: source window changed or anchor is missing/ambiguous; review this proposal again.' : 'Navigation evidence only; no link is accepted.'}${!section ? ' Specific section unknown; full search remains available.' : ''}`,
      observedAt: hints.observedAt,
      fingerprint: place.fingerprint,
      stale,
    };
  });
}
