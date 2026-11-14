/**
 * The Translations tab's Upcoming view (scheduled changes, spec "Editor UX" Translations bullet and
 * "Activation and conflicts" Q4): one row per (open batch member × language) whose batch English
 * differs from the current English, so translators can rework their language before the batch
 * publishes. Pure: the batch listing, member files, and future states come from the editor's
 * Upcoming loader (features/tooltip/UpcomingSwitch.load.ts), which only a flag-ON build loads.
 *
 * States, per language:
 * - needs: the batch carries no translation of its own for the language (the current one, if any,
 *   was written against the current English).
 * - stale: the batch has a translation, but its English changed after it (sourceUpdatedAt older
 *   than the batch English).
 * - changed: the batch translation is ready, but the CURRENT translation was edited after the
 *   batch took its base; at publish the upcoming one replaces it (Q4 "Upcoming wins").
 * - ready: the batch translation was written against the batch English.
 */
import type { Lang, Tooltip } from '@clarity/core';
import type { BatchMember } from '@clarity/core/schedule';
import type { EditorData } from '../../stores/data';
import type { OpenBatch, UpcomingState } from '../tooltip/UpcomingSwitch.store';
import { translatableEntry } from './queue';

export type UpcomingRowState = 'needs' | 'stale' | 'changed' | 'ready';

export interface UpcomingRow {
  /** Unique across batches and languages: `<batchId>:<hash>:<language>`. */
  key: string;
  hash: number;
  language: Lang;
  name: string;
  categoryId: string;
  category: string;
  batchId: string;
  batchName: string;
  state: UpcomingRowState;
  /** The current translation was edited after the batch's base (also flagged on stale rows). */
  currentChanged: boolean;
  /** Category finder order, for sorting. */
  order: number;
  haystack: string;
}

/** One open batch whose members have loaded, with their future state over current saved. */
export interface LoadedBatch {
  batch: OpenBatch;
  upcoming: UpcomingState;
}

const textOf = (tooltip: Tooltip | null | undefined, language: Lang) =>
  tooltip?.text[language]?.text;

/** Whether the batch itself changed `language` (its proposal differs from the base it took). */
function batchChanged(member: BatchMember, language: Lang): boolean {
  return textOf(member.base, language) !== textOf(member.proposed, language);
}

/** One member's state in `language`, given its future tooltip. */
export function upcomingRowState(
  member: BatchMember,
  current: Tooltip | null | undefined,
  future: Tooltip,
  language: Lang,
): { state: UpcomingRowState; currentChanged: boolean } {
  const translation = future.text[language];
  if (!translation || !batchChanged(member, language))
    return { state: 'needs', currentChanged: false };
  // Q4: someone edited the current translation after the batch took its base.
  const currentChanged =
    member.base !== null && textOf(current, language) !== textOf(member.base, language);
  const english = future.text.en;
  const source = translation.sourceUpdatedAt;
  // The tab's own rule: a translation without a known source revision is not guessed outdated.
  const stale = !!english && !!source && Date.parse(english.updatedAt) - Date.parse(source) > 0;
  return { state: stale ? 'stale' : currentChanged ? 'changed' : 'ready', currentChanged };
}

const stateOrder: Record<UpcomingRowState, number> = { needs: 0, stale: 1, changed: 2, ready: 3 };

/**
 * Every Upcoming row for `language`: members whose future English differs from the current
 * English (a tooltip the batch creates has no current English, so it always counts), that are
 * translatable once the batch publishes. Order: needs, stale, changed, ready; then the finder's
 * category order, name, and batch.
 */
export function upcomingRows(
  data: EditorData,
  batches: readonly LoadedBatch[],
  language: Lang,
): UpcomingRow[] {
  const rows: UpcomingRow[] = [];
  for (const { batch, upcoming } of batches) {
    for (const hash of batch.hashes) {
      const member = upcoming.members[hash];
      const future = upcoming.overlay[hash]?.next;
      if (!member || !future) continue;
      const current = data.bundle.tooltips[hash];
      if (textOf(future, 'en') === textOf(current, 'en')) continue;
      const entry = translatableEntry(future, data);
      if (!entry) continue;
      const { state, currentChanged } = upcomingRowState(member, current, future, language);
      rows.push({
        key: `${batch.id}:${hash}:${language}`,
        hash,
        language,
        name: entry.name,
        categoryId: entry.categoryId,
        category: entry.category,
        batchId: batch.id,
        batchName: batch.name,
        state,
        currentChanged,
        order: entry.order,
        haystack: `${entry.haystack}\n${batch.name.toLowerCase()}`,
      });
    }
  }
  rows.sort(
    (a, b) =>
      stateOrder[a.state] - stateOrder[b.state] ||
      a.order - b.order ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name) ||
      a.batchName.localeCompare(b.batchName) ||
      a.hash - b.hash,
  );
  return rows;
}

/** "To do" = needs, stale, and changed (each wants a look); "Ready" = ready. */
export type UpcomingFilter = 'todo' | 'ready' | null;

export function parseUpcomingFilter(value: string | null): UpcomingFilter {
  return value === 'todo' || value === 'ready' ? value : null;
}

export interface UpcomingFilters {
  state: UpcomingFilter;
  category: string | null;
  query: string;
}

export function filterUpcoming(
  rows: readonly UpcomingRow[],
  filters: UpcomingFilters,
): readonly UpcomingRow[] {
  const needle = filters.query.trim().toLowerCase();
  if (!filters.state && !filters.category && !needle) return rows;
  return rows.filter(
    (row) =>
      (!filters.state || (row.state === 'ready') === (filters.state === 'ready')) &&
      (!filters.category || row.categoryId === filters.category) &&
      (!needle || row.haystack.includes(needle)),
  );
}

export function countUpcoming(rows: readonly UpcomingRow[]): { todo: number; ready: number } {
  let ready = 0;
  for (const row of rows) if (row.state === 'ready') ready++;
  return { todo: rows.length - ready, ready };
}

export interface UpcomingCoverage {
  ready: number;
  changed: number;
  stale: number;
  needs: number;
}

/** Per-state counts of `rows`, over every category or only `category`. */
export function upcomingCoverage(
  rows: readonly UpcomingRow[],
  category?: string | null,
): UpcomingCoverage {
  const counts: UpcomingCoverage = { ready: 0, changed: 0, stale: 0, needs: 0 };
  for (const row of rows) if (!category || row.categoryId === category) counts[row.state]++;
  return counts;
}

/** Categories that have rows, in finder order, with row counts. */
export function upcomingCategories(
  rows: readonly UpcomingRow[],
): { id: string; label: string; count: number }[] {
  const found = new Map<string, { id: string; label: string; count: number; order: number }>();
  for (const row of rows) {
    const entry = found.get(row.categoryId);
    if (entry) entry.count++;
    else
      found.set(row.categoryId, {
        id: row.categoryId,
        label: row.category,
        count: 1,
        order: row.order,
      });
  }
  return [...found.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ id, label, count }) => ({ id, label, count }));
}

export const upcomingStateText: Record<UpcomingRowState, string> = {
  needs: 'Needs translation',
  stale: 'Stale',
  changed: 'Current changed',
  ready: 'Ready',
};

export function upcomingStateTitle(row: Pick<UpcomingRow, 'state' | 'currentChanged'>): string {
  const changed =
    'The current translation was edited after your rework; the upcoming one replaces it when the batch publishes.';
  switch (row.state) {
    case 'needs':
      return 'The batch changes the English and has no translation for it yet.';
    case 'stale':
      return `The batch English changed after this translation.${row.currentChanged ? ` ${changed}` : ''}`;
    case 'changed':
      return changed;
    case 'ready':
      return 'Translated against the batch English.';
  }
}
