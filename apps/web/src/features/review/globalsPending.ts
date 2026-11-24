import {
  exportLegacy,
  globalsInPlaceDefinition,
  languages,
  MissingGlobalTranslation,
  resolveGlobalsInPlace,
  type GlobalsInPlaceOptions,
  type GlobalsPending,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
} from '@clarity/core';
import type { Bundle } from '../../services/bundle';
import type { EditorData } from '../../stores/data';
import { globalTypes, type GlobalKind } from '../globals/model';
import type { PendingTooltip } from './model';
import { exportedText } from './published';

export type PendingGlobal = GlobalsPending[number];

const keys = new Map<string, number>();
/**
 * Ticks and running publishes are kept by tooltip hash. A global has none: a negative number stands
 * in for it within this tab, and requests name it by its id.
 */
export function globalKey(id: string): number {
  let key = keys.get(id);
  if (key === undefined) keys.set(id, (key = -keys.size - 1));
  return key;
}

const noun = { variables: 'variable', titles: 'title', exports: 'export' } as const;
/** What a row shows where a tooltip shows its hash. */
export const rowIdentity = ({ tooltip, part }: PendingTooltip): string =>
  part?.pending ? noun[part.kind] : String(tooltip.hash);

/** One ordinary row per global whose saved definition is not the published one. */
export function globalEntries(
  data: EditorData,
  {
    order,
    settled,
    ahead,
  }: { order: number; settled: ReadonlySet<string>; ahead: ReadonlySet<string> },
): PendingTooltip[] {
  return (data.bundle.globalsPending ?? []).flatMap((pending) => {
    if (settled.has(pending.id)) return [];
    const hash = globalKey(pending.id);
    const side = (which: 'before' | 'after') => {
      const source: Partial<Record<Lang, string>> = {};
      const tooltip: Tooltip = { hash, text: {}, associated: [] };
      for (const lang of languages) {
        const text = pending.languages[lang]?.[which];
        if (typeof text !== 'string') continue;
        source[lang] = text;
        tooltip.text[lang] = { text, updatedAt: '', updatedBy: '' };
      }
      return { source, tooltip };
    };
    const before = side('before');
    const after = side('after');
    const unpublishable =
      pending.refusal ??
      (ahead.has(pending.id)
        ? 'It was saved after this list was built. Refresh to review it.'
        : undefined);
    const entry: PendingTooltip = {
      tooltip: after.tooltip,
      name: pending.name,
      category: 'Globals',
      categoryId: '~globals',
      categoryOrder: order,
      markerOnly: false,
      isNew: pending.change === 'new',
      ...(unpublishable === undefined ? {} : { unpublishable }),
    };
    entry.part = {
      kind: pending.kind,
      name: pending.name,
      unit: entry,
      names: [pending.name],
      published: {
        status: 'ready',
        tooltip: pending.change === 'new' ? null : before.tooltip,
      },
      source: { before: before.source, after: after.source },
      pending,
      ...(pending.change === 'removed' || pending.change === 'renamed'
        ? { change: pending.change }
        : {}),
    };
    return [entry];
  });
}

type Definitions = Record<GlobalKind, Record<string, Partial<Record<Lang, { body: string }>>>>;
const none = (): Definitions => ({
  variables: Object.create(null),
  titles: Object.create(null),
  exports: Object.create(null),
});
/** New and renamed globals: their names are not published yet. */
const unpublishedName = ({ change }: PendingGlobal) => change === 'new' || change === 'renamed';

const publishedStores = new WeakMap<Bundle, { live: Definitions; next: Definitions }>();
/**
 * The globals as published (`live`), and with the names a tooltip can only use by publishing them
 * along (`next`). A language counts as it publishes: without a current translation it has none.
 */
function publishedDefinitions(bundle: Bundle): { live: Definitions; next: Definitions } {
  const known = publishedStores.get(bundle);
  if (known) return known;
  const live = none();
  const added = none();
  const pending = new Map((bundle.globalsPending ?? []).map((entry) => [entry.id, entry]));
  const entries = bundle.globals?.entries ?? [];
  const saved = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of new Set([...saved.keys(), ...pending.keys()])) {
    const entry = saved.get(id);
    const change = pending.get(id);
    if (!change && entry?.tombstone) continue;
    const { kind, name } = change ?? entry!;
    const before: Definitions['titles'][string] = {};
    const after: Definitions['titles'][string] = {};
    for (const lang of languages) {
      const cell = change?.languages[lang];
      const current = entry && globalsInPlaceDefinition(entry.definitions, lang);
      const old = cell
        ? cell.beforeAvailable === false
          ? null
          : cell.before
        : (current?.body ?? null);
      if (old !== null) before[lang] = { body: old };
      if (current) after[lang] = { body: current.body };
    }
    if (change && unpublishedName(change)) added[kind][name] = after;
    if (change?.change === 'new') continue;
    // The contract does not carry the published name: any earlier name of a renamed global is it.
    const names =
      change?.change === 'renamed' ? (entry?.nameHistory.map((old) => old.name) ?? []) : [name];
    for (const published of names) live[kind][published] ??= before;
  }
  const next: Definitions = {
    variables: { ...live.variables, ...added.variables },
    titles: { ...live.titles, ...added.titles },
    exports: { ...live.exports, ...added.exports },
  };
  const store = { live, next };
  publishedStores.set(bundle, store);
  return store;
}

/**
 * New (and renamed) globals that the chosen rows use and that are not chosen: nothing published
 * holds those names yet, so they publish together. Another pending change is never needed.
 */
export function neededGlobals(
  chosen: readonly PendingTooltip[],
  pending: readonly PendingTooltip[],
  data: EditorData,
): { global: PendingTooltip; by: PendingTooltip }[] {
  const fresh = new Map(
    pending
      .filter(({ part }) => part?.pending && unpublishedName(part.pending))
      .map((entry) => [entry.name, entry]),
  );
  if (!fresh.size) return [];
  const { live, next } = publishedDefinitions(data.bundle);
  const included = new Set(chosen);
  const needed: { global: PendingTooltip; by: PendingTooltip }[] = [];
  for (const by of included) {
    if (by.inactiveChange === 'remove') continue;
    for (let found = true; found;) {
      found = false;
      const definitions = none();
      const unavailable = {
        variables: new Set<string>(),
        titles: new Set<string>(),
        exports: new Set<string>(),
      };
      for (const { kind } of globalTypes)
        for (const [name, entry] of Object.entries(next[kind])) {
          const global = fresh.get(name);
          if (live[kind][name] || (global && included.has(global))) definitions[kind][name] = entry;
          else unavailable[kind].add(name);
        }
      // The publisher's own reading of the text, and its reason when a name is not published.
      const reason = refusalOf(by, { definitions, unavailable });
      const global = fresh.get(
        /Publish the shared change for (.+) first\./.exec(reason)?.[1] ?? '',
      );
      if (global && !included.has(global)) {
        included.add(global);
        needed.push({ global, by });
        found = true;
      }
    }
  }
  return needed;
}

function refusalOf({ tooltip, part }: PendingTooltip, options: GlobalsInPlaceOptions): string {
  try {
    if (!part?.pending) exportLegacy([tooltip], 0, undefined, {}, { globalsInPlace: options });
    else
      for (const lang of languages) {
        const text = tooltip.text[lang]?.text;
        if (text) resolveGlobalsInPlace(text, lang, options);
      }
  } catch (reason) {
    return String(reason);
  }
  return '';
}

/**
 * A tooltip's text as it publishes in a language: its globals filled in as published, and English
 * as a whole where one of them has no current translation.
 */
export function publishedText(
  data: EditorData | null,
  tooltip: Tooltip | null,
  lang: Lang,
  side: 'live' | 'next',
): string {
  const text = exportedText(tooltip, lang);
  if (!data?.bundle.globalsPending?.length || !tooltip || tooltip.hash < 0) return text;
  const definitions = publishedDefinitions(data.bundle)[side];
  const uses = (value: string) =>
    globalTypes.some(({ kind }) => Object.keys(definitions[kind]).some((n) => value.includes(n)));
  if (!uses(text)) return text;
  try {
    return resolveGlobalsInPlace(text, lang, { definitions });
  } catch (reason) {
    if (!(reason instanceof MissingGlobalTranslation) || lang === 'en') return text;
    return publishedText(data, tooltip, 'en', side);
  }
}

/** What a filled text's imports still read: the published globals, never a pending change. */
export function publishedGlobals(
  globals: MarkupGlobals,
  data: EditorData | null,
  lang: Lang,
): MarkupGlobals {
  if (!data?.bundle.globalsPending?.length) return globals;
  const { next } = publishedDefinitions(data.bundle);
  const library = (kind: GlobalKind, declare: (name: string, body: string) => string) =>
    Object.entries(next[kind])
      .flatMap(([name, entry]) => {
        const body = (entry[lang] ?? entry.en)?.body;
        return body === undefined ? [] : [declare(name, body)];
      })
      .join('\n');
  const exports = library('exports', (name, body) => `export ${name} (\n${body}\n)`);
  return {
    ...globals,
    variables: library('variables', (name, body) => `var ${name} = ${body.trim() || 'empty'}`),
    titles: library('titles', (name, body) => `title ${name} (\n${body}\n)`),
    imports: Object.assign(Object.create(globals.imports ?? null) as Record<string, string>, {
      1: exports,
      global: exports,
    }),
  };
}
