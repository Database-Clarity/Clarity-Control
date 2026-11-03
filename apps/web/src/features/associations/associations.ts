import { resolveAlias } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { itemFor } from '../navigation/catalog';

export function associationCandidates(
  data: EditorData,
  query: string,
  self: number,
  selected: readonly number[],
) {
  const search = query.trim().toLowerCase();
  const excluded = new Set([self, ...selected].map((hash) => resolveAlias(hash, data.aliases)));
  const matches = new Set<number>();
  const hashes = new Set([
    ...Object.keys(data.items),
    ...Object.keys(data.bundle.tooltips),
    ...Object.keys(data.aliases),
  ]);
  for (const hash of hashes) {
    const canonical = resolveAlias(Number(hash), data.aliases);
    // Hashes 1-3 are reserved global documents; archived tooltips are retired.
    if (excluded.has(canonical) || canonical <= 3 || data.bundle.tooltips[canonical]?.archive)
      continue;
    const item = itemFor(Number(hash), data) ?? itemFor(canonical, data);
    if (!search || hash.includes(search) || item?.name.toLowerCase().includes(search))
      matches.add(canonical);
  }
  return [...matches].sort(
    (a, b) => (itemFor(a, data)?.name ?? '').localeCompare(itemFor(b, data)?.name ?? '') || a - b,
  );
}

export function moveAssociation(
  associated: readonly number[],
  index: number,
  direction: -1 | 1,
): number[] {
  const next = [...associated];
  const target = index + direction;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
