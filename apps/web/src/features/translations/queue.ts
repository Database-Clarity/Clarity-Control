import {
  isTranslatable,
  translationStateOf,
  type Lang,
  type Tooltip,
  type TranslationState,
} from '@clarity/core';
import {
  classifyItem,
  listingCategoryId,
  derivedCategories,
  enhancedPartCategory,
  inactiveCategory,
  isSetSelector,
} from '../compendium/itemClassification';
import { exoticArmourCategory, exoticArmourLabel, itemFor, listName } from '../navigation/catalog';
import type { EditorData } from '../../stores/data';

/** A tooltip that can be translated: shown in the finder, with English text, not a placeholder. */
export interface Translatable {
  tooltip: Tooltip;
  hash: number;
  name: string;
  categoryId: string;
  category: string;
  /** Lowercased search text: name, hash, category. */
  haystack: string;
}

/** One row of a language's queue: a tooltip that still needs work in that language. */
export interface QueueRow {
  key: string;
  hash: number;
  language: Lang;
  name: string;
  categoryId: string;
  category: string;
  state: Exclude<TranslationState, 'current'>;
  /** Outdated only: how far the translation's English source trails the current English. */
  ageMs?: number;
  /** Outdated only: the gap exceeds the export limit, so English is exported instead. */
  exportedInEnglish?: boolean;
  haystack: string;
}

export interface Coverage {
  translated: number;
  outdated: number;
  missing: number;
}

export interface TranslationIndex {
  /** Finder order: category order, then name. */
  translatable: readonly Translatable[];
  /** Categories that have translatable tooltips, in finder order. */
  categories: readonly { id: string; label: string }[];
  queue(language: Lang): readonly QueueRow[];
  /** Counts for one language, over every category or only `category` (zero for an unknown id). */
  coverage(language: Lang, category?: string | null): Coverage;
}

const indexes = new WeakMap<EditorData, TranslationIndex>();

/**
 * Everything the Translations tab needs, built once per loaded data set. Placeholders (set
 * selectors, Inactive & Placeholder Items), enhanced weapon parts, aliases, archived tooltips, and
 * tooltips without English text are never translatable. State per language comes from core's `translationStateOf`,
 * the same rule the editor's translator diff uses.
 */
export function translationIndex(data: EditorData): TranslationIndex {
  let index = indexes.get(data);
  if (!index) indexes.set(data, (index = buildIndex(data)));
  return index;
}

const categoryMaps = new WeakMap<EditorData, Map<string, EditorData['categories'][number]>>();

function categoryMap(data: EditorData) {
  let map = categoryMaps.get(data);
  if (!map)
    categoryMaps.set(
      data,
      (map = new Map(
        [
          ...data.categories,
          ...derivedCategories.filter(
            (c) => !data.categories.some((existing) => existing.id === c.id),
          ),
        ].map((category) => [category.id, category] as const),
      )),
    );
  return map;
}

/**
 * `tooltip` as a Translations row source (name, category, search text), or null when it is never
 * translatable: aliases, archived tooltips, tooltips without English text, set selectors, Inactive
 * & Placeholder Items, and enhanced weapon parts. `order` is the category's finder order.
 */
export function translatableEntry(
  tooltip: Tooltip,
  data: EditorData,
): (Translatable & { order: number }) | null {
  if (!isTranslatable(tooltip, data.aliases)) return null;
  const item = itemFor(tooltip.hash, data);
  let categoryId = 'unknown';
  let name = String(tooltip.hash);
  if (item) {
    if (isSetSelector(item)) return null;
    const classified = listingCategoryId(item, classifyItem(item, tooltip));
    if (classified === inactiveCategory || classified === enhancedPartCategory) return null;
    categoryId = classified;
    name = listName(item, data) || name;
  }
  const category = categoryMap(data).get(categoryId);
  const label =
    categoryId === exoticArmourCategory ? exoticArmourLabel : (category?.label ?? 'Other');
  return {
    tooltip,
    hash: tooltip.hash,
    name,
    categoryId,
    category: label,
    haystack: `${name}
${tooltip.hash}
${label}`.toLowerCase(),
    order: category?.order ?? 9999,
  };
}

function buildIndex(data: EditorData): TranslationIndex {
  const translatable: Translatable[] = [];
  const order = new Map<string, number>();
  for (const tooltip of Object.values(data.bundle.tooltips)) {
    const entry = translatableEntry(tooltip, data);
    if (!entry) continue;
    const { order: categoryOrder, ...row } = entry;
    if (!order.has(row.categoryId)) order.set(row.categoryId, categoryOrder);
    translatable.push(row);
  }
  translatable.sort(
    (a, b) =>
      order.get(a.categoryId)! - order.get(b.categoryId)! ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name) ||
      a.hash - b.hash,
  );
  const listed = new Map<string, { id: string; label: string }>();
  for (const entry of translatable)
    if (!listed.has(entry.categoryId))
      listed.set(entry.categoryId, { id: entry.categoryId, label: entry.category });
  const queues = new Map<Lang, QueueRow[]>();
  const coverages = new Map<Lang, LanguageCoverage>();
  return {
    translatable,
    categories: [...listed.values()],
    queue(language) {
      let queue = queues.get(language);
      if (!queue) queues.set(language, (queue = buildQueue(translatable, language)));
      return queue;
    },
    coverage(language, category) {
      let coverage = coverages.get(language);
      if (!coverage) coverages.set(language, (coverage = buildCoverage(translatable, language)));
      return category ? (coverage.byCategory.get(category) ?? noCoverage) : coverage.total;
    },
  };
}

interface LanguageCoverage {
  total: Coverage;
  byCategory: Map<string, Coverage>;
}

const noCoverage: Coverage = Object.freeze({ translated: 0, outdated: 0, missing: 0 });

/** One pass per language gives the total and every category's counts, so a filter is a lookup. */
function buildCoverage(translatable: readonly Translatable[], language: Lang): LanguageCoverage {
  const total: Coverage = { translated: 0, outdated: 0, missing: 0 };
  const byCategory = new Map<string, Coverage>();
  for (const entry of translatable) {
    const { state } = translationStateOf(entry.tooltip, language);
    const key = state === 'current' ? 'translated' : state;
    let counts = byCategory.get(entry.categoryId);
    if (!counts)
      byCategory.set(entry.categoryId, (counts = { translated: 0, outdated: 0, missing: 0 }));
    counts[key]++;
    total[key]++;
  }
  return { total, byCategory };
}

/** Outdated first (largest English gap first), then missing in finder order. */
function buildQueue(translatable: readonly Translatable[], language: Lang): QueueRow[] {
  const outdated: QueueRow[] = [];
  const missing: QueueRow[] = [];
  for (const entry of translatable) {
    const result = translationStateOf(entry.tooltip, language);
    if (result.state === 'current') continue;
    const row: QueueRow = {
      key: `${entry.hash}:${language}`,
      hash: entry.hash,
      language,
      name: entry.name,
      categoryId: entry.categoryId,
      category: entry.category,
      state: result.state,
      ageMs: result.ageMs,
      exportedInEnglish: result.exportedInEnglish,
      haystack: entry.haystack,
    };
    (result.state === 'outdated' ? outdated : missing).push(row);
  }
  outdated.sort((a, b) => b.ageMs! - a.ageMs!);
  return outdated.concat(missing);
}

export type StateFilter = 'outdated' | 'missing' | null;

export function parseStateFilter(value: string | null): StateFilter {
  return value === 'outdated' || value === 'missing' ? value : null;
}

export interface QueueFilters {
  state: StateFilter;
  category: string | null;
  query: string;
}

export function filterRows(rows: readonly QueueRow[], filters: QueueFilters): readonly QueueRow[] {
  const needle = filters.query.trim().toLowerCase();
  if (!filters.state && !filters.category && !needle) return rows;
  return rows.filter(
    (row) =>
      (!filters.state || row.state === filters.state) &&
      (!filters.category || row.categoryId === filters.category) &&
      (!needle || row.haystack.includes(needle)),
  );
}

/**
 * The rows one queue view lists, in its order. The Translations tab and the editor's queue control
 * both take their list from here, so Next in the editor is always the next row of the tab.
 */
export function queueFor(
  index: TranslationIndex,
  language: Lang,
  filters: QueueFilters,
): readonly QueueRow[] {
  return filterRows(index.queue(language), filters);
}

/** Categories that have rows, in finder order, with row counts. */
export function categoryOptions(
  rows: readonly QueueRow[],
  categories: TranslationIndex['categories'],
): { id: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
  return categories.flatMap((category) => {
    const count = counts.get(category.id);
    return count ? [{ ...category, count }] : [];
  });
}

export function countRows(rows: readonly QueueRow[]): { outdated: number; missing: number } {
  let outdated = 0;
  for (const row of rows) if (row.state === 'outdated') outdated++;
  return { outdated, missing: rows.length - outdated };
}

/** "3 d", "5 mo": how long a translation has trailed English, as short as possible. */
export function behindLabel(ageMs: number): string {
  const days = Math.max(1, Math.round(ageMs / 86_400_000));
  if (days < 60) return `${days} d`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `${months} mo` : `${Math.round(days / 365)} y`;
}
