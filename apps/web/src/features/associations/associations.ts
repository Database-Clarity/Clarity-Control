import { resolveAlias } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { itemFor } from '../navigation/catalog';

interface Candidate {
  hash: number;
  name: string;
  search: string[];
}
const candidateIndexes = new WeakMap<EditorData, Candidate[]>();

function candidateIndex(data: EditorData) {
  const cached = candidateIndexes.get(data);
  if (cached) return cached;
  const candidates = new Map<number, Candidate>();
  const hashes = new Set([
    ...Object.keys(data.items),
    ...Object.keys(data.bundle.tooltips),
    ...Object.keys(data.aliases),
  ]);
  for (const hash of hashes) {
    const canonical = resolveAlias(Number(hash), data.aliases);
    if (canonical <= 3 || data.bundle.tooltips[canonical]?.archive) continue;
    let candidate = candidates.get(canonical);
    if (!candidate) {
      candidate = { hash: canonical, name: itemFor(canonical, data)?.name ?? '', search: [] };
      candidates.set(canonical, candidate);
    }
    const item = itemFor(Number(hash), data) ?? itemFor(canonical, data);
    candidate.search.push(hash);
    if (item) candidate.search.push(item.name.toLowerCase());
  }
  const index = [...candidates.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.hash - right.hash,
  );
  candidateIndexes.set(data, index);
  return index;
}

export function associationCandidates(
  data: EditorData,
  query: string,
  self: number,
  selected: readonly number[],
) {
  const search = query.trim().toLowerCase();
  const excluded = new Set([self, ...selected].map((hash) => resolveAlias(hash, data.aliases)));
  return candidateIndex(data)
    .filter(
      (candidate) =>
        !excluded.has(candidate.hash) &&
        (!search || candidate.search.some((token) => token.includes(search))),
    )
    .map((candidate) => candidate.hash);
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
