import { languages, type Lang, type Tooltip } from '@clarity/core';
import { create } from 'zustand';
import type { EditorData } from '../../stores/data';
import { diffGlobals } from '../history/RenderedWordDiff';
import { classifyRendered } from '../history/useRenderedDiff';
import { publishedOf, rowKey, usesOthers, type RowKey } from './globalRows';
import type { PendingTooltip } from './model';
import { exportedText, usePublished, type Published } from './published';
import type { RowKinds } from './queueModel';

type PublishedState = ReturnType<typeof usePublished.getState>;

/**
 * The plain word each waiting change shows (spec §5), known without opening the row. The same
 * words name the kind filter's options and the confirm dialog's counts.
 */
export const kindWords = [
  'Text changed',
  'Global changed',
  'No visible change',
  'Output unchanged',
  'Definition changed',
  'New',
  'Links changed',
  'Removed',
  'Restored',
  'On hold',
  'Leftover',
] as const;
export type Kind = (typeof kindWords)[number];

export interface Classification {
  kind: Kind;
  /** Text changed, or Global changed: the languages whose rendered text differs. */
  languages?: Lang[];
  /** Text changed on a text with Base and Enhanced forms: which of them change. */
  scope?: 'both' | 'base' | 'enhanced';
  /** Base and Enhanced render differently (show both columns). */
  variants?: boolean;
  /** No visible change: how many source lines changed. */
  markupLines?: number;
  /** Text changed through the stored number values only. */
  numbers?: boolean;
}

/** What a row is without its published text, or undefined when that text decides. */
export function localKind(entry: PendingTooltip): Classification | undefined {
  if (entry.inactiveChange === 'remove') return { kind: 'Removed' };
  if (entry.inactiveChange === 'restore') return { kind: 'Restored' };
  if (entry.unpublishable) return { kind: 'On hold' };
  if (entry.markerOnly) return { kind: 'Leftover' };
  if (entry.globals?.unedited && entry.globals.causes.length) return { kind: 'Global changed' };
  if (entry.part?.change === 'removed') return { kind: 'Removed' };
  if (entry.part?.change === 'same-text')
    return { kind: usesOthers(entry.tooltip) ? 'Definition changed' : 'Output unchanged' };
  if (entry.isNew) return { kind: 'New' };
  return undefined;
}

/** Languages whose saved source or exported text differs. */
export const textLanguages = (before: Tooltip | null, current: Tooltip) =>
  languages.filter(
    (lang) =>
      before?.text[lang]?.text !== current.text[lang]?.text ||
      exportedText(before, lang) !== exportedText(current, lang),
  );

/** Text with every global filled in, as it publishes; only its imports are looked up. */
export const publishedGlobals = (data: EditorData | null, lang: Lang, hash: number) => ({
  ...diffGlobals(data, {}, lang, hash, 'live'),
  titles: '',
});

/** What changes per language: the text as it publishes when a global changes it, else the saved. */
export function textChanges(entry: PendingTooltip, before: Tooltip | null) {
  const diff = entry.globals?.diff;
  return diff
    ? languages.flatMap((lang) => {
        const from = diff[lang]?.before?.main ?? '',
          to = diff[lang]?.after?.main ?? '';
        return from === to ? [] : [{ lang, before: from, after: to }];
      })
    : textLanguages(before, entry.tooltip).map((lang) => ({
        lang,
        before: exportedText(before, lang),
        after: exportedText(entry.tooltip, lang),
      }));
}

/** Source lines between the first and last changed line (the larger side). */
export function changedLines(before: string, after: string): number {
  if (before === after) return 0;
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return Math.max(endA - start, endB - start, 1);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Associated tooltips, custom identity (category, name), or the Compendium link differ. */
export function linksChanged(before: Tooltip, current: Tooltip): boolean {
  return (
    !same(before.associated, current.associated) ||
    !same(before.custom, current.custom) ||
    !same(before.compendium, current.compendium)
  );
}

type Output = { base: boolean; enhanced: boolean; variantsDiffer: boolean };

/**
 * The word for a published row from its rendered comparison per changed language (`outputs`,
 * same order as `changed`). A failed check leaves the row without a word (never a guess).
 * `Text changed` wins over everything else on the row.
 */
export function publishedKind(
  before: Tooltip | null,
  current: Tooltip,
  outputs: readonly (Output | undefined)[],
  changed = textLanguages(before, current),
): Classification | undefined {
  if (!before) return { kind: 'New' };
  if (outputs.some((output) => !output)) return undefined;
  const visible = changed.filter((_, index) => outputs[index]!.base || outputs[index]!.enhanced);
  if (visible.length) {
    const shown = outputs.filter((output) => output!.base || output!.enhanced) as Output[];
    const variants = outputs.some((output) => output!.variantsDiffer);
    const base = shown.some((output) => output.base),
      enhanced = shown.some((output) => output.enhanced);
    return {
      kind: 'Text changed',
      languages: visible,
      variants,
      ...(variants ? { scope: base && enhanced ? 'both' : base ? 'base' : 'enhanced' } : {}),
    };
  }
  // The stored number values feed the numbers players read; the publish digest covers them too.
  if (!same(before.text.en?.numbers, current.text.en?.numbers))
    return { kind: 'Text changed', languages: ['en'], variants: false, numbers: true };
  if (linksChanged(before, current)) return { kind: 'Links changed' };
  return {
    kind: 'No visible change',
    markupLines: changed.reduce(
      (sum, lang) =>
        sum + changedLines(before.text[lang]?.text ?? '', current.text[lang]?.text ?? ''),
      0,
    ),
  };
}

// ---- background classification ----
type Diff = NonNullable<PendingTooltip['globals']>['diff'] | undefined;
interface Classified {
  saved: Tooltip;
  savedJson: string;
  diff: Diff;
  published: Tooltip | null;
  tooltips: EditorData['bundle']['tooltips'];
  aliases: EditorData['aliases'];
  value: Classification | undefined;
}
interface KindsState {
  byHash: Readonly<Record<RowKey, Classified>>;
}
export const useKinds = create<KindsState>(() => ({ byHash: {} }));

/** A tooltip is checked once, however many globals list it. */
const checkKey = (entry: PendingTooltip): RowKey =>
  entry.part ? rowKey(entry) : entry.tooltip.hash;

/** The row's word: local, or the background result for exactly this saved and published text. */
export function kindOf(
  entry: PendingTooltip,
  published: Published | undefined,
  byHash: KindsState['byHash'],
): Classification | undefined {
  const local = localKind(entry);
  if (local && local.kind !== 'Global changed') return local;
  if (published?.status !== 'ready') return undefined;
  if (!published.tooltip) return { kind: 'New' };
  const done = byHash[checkKey(entry)];
  // A reload (Refresh) brings equal saved text in new objects: the word stays while it is checked
  // again against the new imports, never blanking.
  return done && done.published === published.tooltip && sameSaved(done, entry)
    ? done.value
    : local;
}

/** The classified saved text is this one (same object, or the same content after a reload). */
function sameSaved(done: Classified, entry: PendingTooltip) {
  return (
    (done.saved === entry.tooltip && done.diff === entry.globals?.diff) ||
    done.savedJson === savedJson(entry)
  );
}
const savedJson = ({ tooltip, globals }: PendingTooltip) =>
  JSON.stringify(globals ? [tooltip, globals.diff] : tooltip);

/** The latest check asked for per row; an older check's answer never replaces a newer one. */
const running = new Map<
  RowKey,
  {
    saved: Tooltip;
    diff: Diff;
    before: Tooltip;
    tooltips: EditorData['bundle']['tooltips'];
    aliases: EditorData['aliases'];
  }
>();

/**
 * Classify every row whose published text is in hand and that has no result for it yet. The
 * rendered checks run in the diff worker; the page never waits for them. `open`: also check rows
 * whose word is known without it (how their text changed shows with them).
 */
export function classifyRows(
  rows: readonly { entry: PendingTooltip; published: Published | undefined }[],
  data: EditorData,
  open = false,
) {
  const byHash = useKinds.getState().byHash;
  const {
    aliases,
    bundle: { tooltips },
  } = data;
  for (const { entry, published } of rows) {
    const local = localKind(entry);
    if (local && !(open && local.kind === 'Global changed')) continue;
    if (published?.status !== 'ready' || !published.tooltip) continue;
    const saved = entry.tooltip,
      before = published.tooltip,
      diff = entry.globals?.diff;
    const key = checkKey(entry);
    const done = byHash[key];
    if (
      done &&
      done.saved === saved &&
      done.diff === diff &&
      done.published === before &&
      done.tooltips === tooltips &&
      done.aliases === aliases
    ) {
      // A return to the checked snapshot supersedes a check still running for another snapshot.
      running.delete(key);
      continue;
    }
    // New objects (a reload) or new imports: check again; the old word shows meanwhile.
    const pending = running.get(key);
    if (
      pending?.saved === saved &&
      pending.diff === diff &&
      pending.before === before &&
      pending.tooltips === tooltips &&
      pending.aliases === aliases
    )
      continue;
    const request = { saved, diff, before, tooltips, aliases };
    running.set(key, request);
    const changed = textChanges(entry, before);
    void Promise.all(
      changed.map(({ lang, before: from, after: to }) =>
        classifyRendered(
          from,
          to,
          diff
            ? publishedGlobals(data, lang, saved.hash)
            : diffGlobals(data, {}, lang, saved.hash, 'live'),
        ),
      ),
    ).then((outputs) => {
      // A newer check for this row (new saved text, published text, or imports) owns the result.
      if (running.get(key) !== request) return;
      running.delete(key);
      const langs = changed.map(({ lang }) => lang);
      const checked = publishedKind(before, saved, outputs, langs);
      const value: Classification | undefined = local
        ? {
            ...checked,
            kind: local.kind,
            // A failed check shows every language rather than claiming nothing changed.
            languages: checked ? (checked.languages ?? []) : langs,
          }
        : checked;
      // Both sides rendered with the saved imports: for a globals entry that uses others, equal
      // output is not proven.
      const unproven =
        entry.part &&
        value?.kind === 'No visible change' &&
        (usesOthers(before) || usesOthers(saved));
      useKinds.setState((state) => ({
        byHash: {
          ...state.byHash,
          [key]: {
            saved,
            savedJson: savedJson(entry),
            diff,
            published: before,
            tooltips,
            aliases,
            value: unproven ? { kind: 'Definition changed' as const } : value,
          },
        },
      }));
    });
  }
}

let rowMemo:
  | {
      entries: readonly PendingTooltip[];
      published: PublishedState['byHash'];
      kinds: KindsState['byHash'];
      value: Map<RowKey, Kind | undefined>;
    }
  | undefined;

/** Every row's word by its key; one shared result per state, so the list and page agree. */
export function rowKinds(
  entries: readonly PendingTooltip[],
  published: PublishedState['byHash'],
  kinds: KindsState['byHash'],
): RowKinds {
  if (rowMemo?.entries === entries && rowMemo.published === published && rowMemo.kinds === kinds)
    return rowMemo.value;
  const value = new Map<RowKey, Kind | undefined>();
  for (const entry of entries)
    value.set(rowKey(entry), kindOf(entry, publishedOf(entry, published), kinds)?.kind);
  rowMemo = { entries, published, kinds, value };
  return value;
}

const noEntries: PendingTooltip[] = [];
export function useRowKinds(entries: readonly PendingTooltip[] | null): RowKinds {
  const published = usePublished((state) => state.byHash);
  const kinds = useKinds((state) => state.byHash);
  return rowKinds(entries ?? noEntries, published, kinds);
}

/** "19 new tooltips and 6 with no visible change": the confirm dialog's line. */
export function kindCounts(kinds: readonly (Kind | undefined)[]): string {
  const counts = new Map<Kind | undefined, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const order: (Kind | undefined)[] = [
    'New',
    ...kindWords.filter((word) => word !== 'New'),
    undefined,
  ];
  const parts = order
    .filter((kind) => counts.has(kind))
    .map((kind, index) => {
      const n = counts.get(kind)!;
      const noun = index === 0 ? (n === 1 ? ' tooltip' : ' tooltips') : '';
      const phrase: Record<Kind | 'unknown', string> = {
        'Text changed': `with changed text`,
        'Global changed': `with a changed global`,
        'No visible change': `with no visible change`,
        'Output unchanged': `with unchanged output`,
        'Definition changed': `with a changed definition`,
        New: `new`,
        'Links changed': `with changed links`,
        Removed: `removed`,
        Restored: `restored`,
        'On hold': `on hold`,
        Leftover: `leftover`,
        unknown: `not checked yet`,
      };
      const words = phrase[kind ?? 'unknown'];
      // Adjectives go before the noun ("19 new tooltips"), phrases after ("6 with …").
      return /^(new|removed|restored|leftover)$/.test(words)
        ? `${n} ${words}${noun}`
        : `${n}${noun} ${words}`;
    });
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}
