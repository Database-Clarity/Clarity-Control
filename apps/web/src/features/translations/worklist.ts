import {
  languages,
  type Lang,
  type Tooltip,
  type TranslationQueueEntry,
  type TranslationState,
} from '@clarity/core';
import type { User } from '../../services/api';

export type WorklistFilter = 'missing' | 'outdated' | 'all';
export const worklistFilters: readonly WorklistFilter[] = ['missing', 'outdated', 'all'];

/** Unknown or absent values fall back to the most actionable view. */
export function parseWorklistFilter(value: string | null): WorklistFilter {
  return worklistFilters.find((filter) => filter === value) ?? 'missing';
}

/** Translators work only in their assigned languages; everyone else sees all of them. */
export function availableLanguages(user: User | null | undefined): Lang[] {
  return languages.filter(
    (lang) => lang !== 'en' && (user?.role !== 'translator' || user.languages?.includes(lang)),
  );
}

export function entryLabel(tooltip: Tooltip, itemName: string | undefined): string {
  return itemName ?? tooltip.custom?.name ?? String(tooltip.hash);
}

const haystacks = new WeakMap<Tooltip, string>();
function haystack(tooltip: Tooltip, name: string): string {
  let value = haystacks.get(tooltip);
  if (value === undefined) {
    value = [name, tooltip.hash, ...Object.values(tooltip.text).map((text) => text?.text ?? '')]
      .join('\n')
      .toLowerCase();
    haystacks.set(tooltip, value);
  }
  return value;
}

/** Filter by state and a case-insensitive search of name, hash and any saved text. */
export function filterQueue(
  entries: readonly TranslationQueueEntry[],
  filter: WorklistFilter,
  query: string,
  nameOf: (tooltip: Tooltip) => string,
): TranslationQueueEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filter === 'all' || entry.state === filter) &&
      (!needle || haystack(entry.tooltip, nameOf(entry.tooltip)).includes(needle)),
  );
}

/** First entry that still needs work; `current` entries are never "next". */
export function nextEntry(entries: readonly TranslationQueueEntry[]): TranslationQueueEntry | null {
  return entries.find((entry) => entry.state !== 'current') ?? null;
}

export function entryPath(entry: Pick<TranslationQueueEntry, 'tooltip' | 'language'>): string {
  return `/t/${entry.tooltip.hash}?lang=${entry.language}`;
}

export function countStates(
  entries: readonly TranslationQueueEntry[],
): Record<TranslationState, number> {
  const counts: Record<TranslationState, number> = { missing: 0, outdated: 0, current: 0 };
  for (const entry of entries) counts[entry.state]++;
  return counts;
}
