import {
  globalsInPlaceDefinition,
  refreshNumberFallbacks,
  stableStringify,
  type GlobalDefinition,
  type Lang,
  type LangText,
  type Tooltip,
  type TranslationLanguage,
} from '@clarity/core';
import { categoryDisplay } from '../../services/categoryLabels';
import {
  translationKey,
  type PendingTranslation,
  type ReadyTranslation,
} from '../../services/translationPublish';
import type { EditorData } from '../../stores/data';
import { savedGlobalsAhead } from '../../stores/savedOverlay';
import { canonicalHash } from '../navigation/catalog';
import { entryPath } from '../translations/worklist';
import { globalCategory, globalKey, globalNoun, publishedCell } from './globalsPending';
import type { PendingTooltip } from './model';
import type { Published } from './published';

/**
 * A translator's Review row: one tooltip or shared text in one assigned language. It is an ordinary
 * row of the list; `tooltip` holds only that language's saved text under a number that stands in
 * for the pair, as a global's row does.
 */
export interface Lane {
  key: string;
  lang: TranslationLanguage;
  /** What the publisher prepared; absent while the bundle does not list this save yet. */
  row: PendingTranslation | undefined;
  /** The tooltip's own hash, or the shared text's ID. */
  hash?: number;
  id?: string;
  /** What a row shows as its identity: the tooltip's hash, or the shared text's kind. */
  identity: string;
  /** The saved text; absent when the translation is removed. */
  saved: LangText | GlobalDefinition | undefined;
  /** The editor in translate mode. */
  editorPath: string;
  /** The published tooltip version to compare with. */
  marker?: string;
  /** A shared text's published text comes with the bundle. */
  published?: Published;
}
export type LaneEntry = PendingTooltip & { lane: Lane };
export const isLane = (entry: PendingTooltip): entry is LaneEntry => entry.lane !== undefined;

export const savedAfterList = 'It was saved after this list was built. Refresh to review it.';

const same = (a: unknown, b: unknown) =>
  a === b || stableStringify(a ?? null) === stableStringify(b ?? null);

let memo: { data: EditorData; key: string; rows: LaneEntry[] } | undefined;

/**
 * Every row of these languages, blocked ones included, in the list's order. `settled`: rows this
 * session published that the loaded bundle still lists.
 */
export function laneEntries(
  data: EditorData,
  langs: readonly TranslationLanguage[],
  settled: ReadonlySet<string>,
): LaneEntry[] {
  const { bundle } = data;
  const globalsAhead = savedGlobalsAhead(bundle);
  // The route and the page ask in turn: they share one list, which the queue's caches are keyed by.
  const key = JSON.stringify([langs, [...settled].sort(), [...globalsAhead].sort()]);
  if (memo?.data === data && memo.key === key) return memo.rows;
  const lanes = bundle.translationPublish?.lanes ?? {};
  const built = (data.tooltipSnapshot ?? bundle).tooltips;
  const rows: LaneEntry[] = [];
  const listed = new Set<string>();
  const ahead = (hash: number, lang: Lang) =>
    bundle.tooltips[hash] !== built[hash] &&
    !same(bundle.tooltips[hash]?.text[lang], built[hash]?.text[lang]);
  for (const lang of langs)
    for (const row of lanes[lang] ?? []) {
      const key = translationKey(row);
      if (listed.has(key)) continue;
      listed.add(key);
      if (row.kind === 'tooltip') {
        const stale = ahead(row.hash, lang) || ahead(row.hash, 'en');
        if (stale || !settled.has(key)) rows.push(tooltipLane(data, row.hash, lang, row, stale));
      } else {
        const stale = globalsAhead.has(row.id);
        if (stale || !settled.has(key)) rows.push(globalLane(data, row.id, lang, row, stale));
      }
    }
  // Saved in this tab after the bundle was built: listed at once, publishable after a refresh.
  if (built !== bundle.tooltips)
    for (const tooltip of Object.values(bundle.tooltips)) {
      const { hash } = tooltip;
      if (built[hash] === tooltip || hash <= 3) continue;
      for (const lang of langs)
        if (!listed.has(`${hash}:${lang}`) && ahead(hash, lang))
          rows.push(tooltipLane(data, hash, lang, undefined, true));
    }
  rows.sort(
    (a, b) =>
      a.categoryOrder - b.categoryOrder ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name) ||
      a.lane.key.localeCompare(b.lane.key, 'en', { numeric: true }),
  );
  memo = { data, key, rows };
  return rows;
}

const byLanguage = new WeakMap<PendingTooltip[], Map<string, PendingTooltip[]>>();
/** A translator's rows of one language (the list's language filter); every row without one. */
export function inLanguage<T extends PendingTooltip>(entries: T[], lang: string | null): T[] {
  if (!lang || !entries.some((entry) => entry.lane?.lang === lang)) return entries;
  let cache = byLanguage.get(entries);
  if (!cache) byLanguage.set(entries, (cache = new Map()));
  let rows = cache.get(lang);
  if (!rows) cache.set(lang, (rows = entries.filter(({ lane }) => lane?.lang === lang)));
  return rows as T[];
}

/** Everything a tick stands for: the saved text, its English, the live text, and the effects. */
const versionOf = (row: ReadyTranslation) =>
  [row.expected, row.english, row.before, row.effects, row.kind === 'global' && row.affected].join(
    ':',
  );

const textOf = (saved: Lane['saved']) => saved && ('text' in saved ? saved.text : saved.body);
const textRecord = (lang: Lang, text: string | null | undefined): Tooltip['text'] =>
  text === null || text === undefined ? {} : { [lang]: { text, updatedAt: '', updatedBy: '' } };

function laneEntry(
  lane: Lane,
  shown: Pick<PendingTooltip, 'name' | 'category' | 'categoryId' | 'categoryOrder'>,
  stale: boolean,
): LaneEntry {
  const { row } = lane;
  return {
    ...shown,
    tooltip: {
      hash: globalKey(lane.key),
      text: textRecord(lane.lang, textOf(lane.saved)),
      associated: [],
    },
    markerOnly: false,
    isNew: false,
    lane,
    ...(!stale && row?.status === 'ready'
      ? { savedVersion: versionOf(row) }
      : {
          unpublishable: stale || !row || row.status === 'ready' ? savedAfterList : row.reason,
        }),
  };
}

function tooltipLane(
  data: EditorData,
  hash: number,
  lang: TranslationLanguage,
  row: PendingTranslation | undefined,
  stale: boolean,
): LaneEntry {
  const tooltip = data.bundle.tooltips[hash];
  const item = data.items[hash];
  const categoryId = item?.categoryId ?? tooltip?.custom?.categoryId ?? 'other';
  const category =
    data.categories.find(({ id }) => id === categoryId) ?? categoryDisplay(categoryId);
  const pushed = data.bundle.pushed[hash];
  return laneEntry(
    {
      key: `${hash}:${lang}`,
      lang,
      row,
      hash,
      identity: String(hash),
      editorPath: entryPath({ hash, language: lang }, canonicalHash(hash, data)),
      saved: tooltip?.text[lang],
      // A stamp-only publish keeps the marker, so its exact snapshot names the version too.
      ...(pushed === undefined
        ? {}
        : { marker: row?.snapshot ? `${pushed}@${row.snapshot}` : pushed }),
    },
    {
      name: item?.name ?? tooltip?.custom?.name ?? `Tooltip ${hash}`,
      category: category.label,
      categoryId,
      categoryOrder: category.order,
    },
    stale,
  );
}

function globalLane(
  data: EditorData,
  id: string,
  lang: TranslationLanguage,
  row: PendingTranslation,
  stale: boolean,
): LaneEntry {
  const { bundle } = data;
  const record = bundle.globals?.entries.find((candidate) => candidate.id === id);
  const pending = bundle.globalsPending?.find((candidate) => candidate.id === id);
  const saved = record?.definitions[lang];
  const cell = pending?.languages[lang];
  const kind = pending?.kind ?? record?.kind;
  const key = `${id}:${lang}`;
  return laneEntry(
    {
      key,
      lang,
      row,
      id,
      identity: kind ? globalNoun[kind] : 'shared text',
      editorPath: `/globals/${id}?lang=${lang}`,
      saved,
      published: {
        status: 'ready',
        tooltip: {
          hash: globalKey(key),
          // Where only the stamps differ, the bundle lists no text change: it is the saved text.
          text: textRecord(lang, cell ? cell.before : saved?.body),
          associated: [],
        },
      },
    },
    {
      // It publishes under its live name; a saved rename stays with the editors.
      name: pending?.previousName ?? pending?.name ?? record?.name ?? id,
      ...globalCategory(data),
    },
    stale,
  );
}

export interface LaneText {
  text: string;
  /** English where the language falls back to it. */
  language: Lang;
}
export interface LaneComparison {
  before: LaneText;
  after: LaneText;
  /** As written: the raw view, and what tells a "Still correct" stamp from a text change. */
  source: { before: string | undefined; after: string | undefined };
}

/** What players see in the row's language now, and after it: the saved text against LIVE English. */
export function laneComparison(
  data: EditorData,
  { lane }: LaneEntry,
  published: Tooltip,
): LaneComparison {
  const { lang, saved, id } = lane;
  const source = { before: published.text[lang]?.text, after: textOf(saved) };
  if (id !== undefined) {
    const cell = data.bundle.globalsPending?.find((entry) => entry.id === id)?.languages[lang];
    const record = data.bundle.globals?.entries.find((entry) => entry.id === id);
    const available =
      cell?.afterAvailable ??
      (!record || !saved || !!globalsInPlaceDefinition(record.definitions, lang));
    return {
      before: {
        text: source.before ?? '',
        language: cell?.beforeAvailable === false ? 'en' : lang,
      },
      after: { text: source.after ?? '', language: available ? lang : 'en' },
      source,
    };
  }
  const composed: Tooltip = structuredClone(published);
  if (saved && 'text' in saved) composed.text[lang] = saved;
  else delete composed.text[lang];
  // The publisher's own step: a fixed formula ends this language's number fallback.
  refreshNumberFallbacks(composed, lang);
  const cell = (tooltip: Tooltip): LaneText =>
    tooltip.text[lang] ? publishedCell(data, tooltip, lang, 'live') : { text: '', language: lang };
  return { before: cell(published), after: cell(composed), source };
}

/**
 * Two rows of one language that change the same tooltip publish one after the other: the second
 * is reviewed again against the first one's result. `held` names the row each of the rest waits for.
 */
export function independentLanes(chosen: readonly LaneEntry[]): {
  sending: LaneEntry[];
  held: ReadonlyMap<LaneEntry, LaneEntry>;
} {
  const taken = new Map<string, LaneEntry>();
  const sending: LaneEntry[] = [];
  const held = new Map<LaneEntry, LaneEntry>();
  for (const entry of chosen) {
    const { lang, hash, row } = entry.lane;
    const cells = (row?.status === 'ready' ? row.affectedHashes : [])
      .concat(hash ?? [])
      .map((target) => `${lang}:${target}`);
    const other = cells.map((cell) => taken.get(cell)).find(Boolean);
    if (other) {
      held.set(entry, other);
      continue;
    }
    for (const cell of cells) taken.set(cell, entry);
    sending.push(entry);
  }
  return { sending, held };
}
