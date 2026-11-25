import {
  exportLegacy,
  globalsInPlaceDefinition,
  globalsInPlaceLibraryText,
  languages,
  isLegacyAliasStub,
  resolveAlias,
  resolveGlobalsInPlace,
  rewriteGlobalRenames,
  rewriteTooltipGlobals,
  UnpublishedGlobal,
  withImportedGlobalsFallback,
  type GlobalsInPlaceOptions,
  type GlobalsPending,
  type GlobalRename,
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
      ...(ahead.has(pending.id) ? {} : { savedVersion: pending.digest }),
      ...(unpublishable === undefined ? {} : { unpublishable }),
    };
    entry.part = {
      kind: pending.kind,
      name: pending.name,
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

type Definition = Partial<Record<Lang, { body: string }>>;
type Definitions = Record<GlobalKind, Record<string, Definition>>;
const none = (): Definitions => ({
  variables: Object.create(null),
  titles: Object.create(null),
  exports: Object.create(null),
});
/** New and renamed globals: their names are not published yet. */
const unpublishedName = ({ change }: PendingGlobal) => change === 'new' || change === 'renamed';

const publishedStores = new WeakMap<
  Bundle,
  {
    live: Definitions;
    next: Definitions;
    saved: Map<string, Definition>;
  }
>();
/**
 * The globals as published (`live`), and with the names a tooltip can only use by publishing them
 * along (`next`). A language counts as it publishes: without a current translation it has none.
 */
function publishedDefinitions(bundle: Bundle) {
  const known = publishedStores.get(bundle);
  if (known) return known;
  const live = none();
  const added = none();
  const savedDefinitions = new Map<string, Definition>();
  const pending = new Map((bundle.globalsPending ?? []).map((entry) => [entry.id, entry]));
  const entries = bundle.globals?.entries ?? [];
  const saved = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of new Set([...saved.keys(), ...pending.keys()])) {
    const entry = saved.get(id);
    const change = pending.get(id);
    const publishedBodies = bundle.globalsReviewDefinitions?.[id];
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
        : publishedBodies
          ? (publishedBodies[lang] ?? null)
          : (current?.body ?? null);
      if (old !== null) before[lang] = { body: old };
      if (current) after[lang] = { body: current.body };
    }
    if (entry && !entry.tombstone) savedDefinitions.set(id, after);
    if (change && unpublishedName(change)) added[kind][name] = after;
    if (change?.change === 'new') continue;
    const published = change?.change === 'renamed' ? change.previousName : name;
    if (published !== undefined) live[kind][published] = before;
  }
  const next: Definitions = {
    variables: { ...live.variables, ...added.variables },
    titles: { ...live.titles, ...added.titles },
    exports: { ...live.exports, ...added.exports },
  };
  const store = { live, next, saved: savedDefinitions };
  publishedStores.set(bundle, store);
  return store;
}

function reviewDefinitions(
  bundle: Bundle,
  side: 'live' | 'next',
  selected?: ReadonlySet<number>,
): GlobalsInPlaceOptions & { renames: readonly GlobalRename[] } {
  const published = publishedDefinitions(bundle);
  if (side === 'live' || !selected) return { definitions: published[side], renames: [] };
  const choices =
    bundle.globalsPending?.filter((entry) => !entry.refusal && selected.has(globalKey(entry.id))) ??
    [];
  const renames = choices.flatMap(({ kind, name, change, previousName }) =>
    change === 'renamed' && previousName ? [{ kind, from: previousName, to: name }] : [],
  );
  const next = none();
  for (const { kind } of globalTypes) {
    for (const [name, cells] of Object.entries(published.live[kind])) {
      next[kind][name] = renames.length
        ? Object.fromEntries(
            Object.entries(cells).map(([lang, { body }]) => [
              lang,
              { body: rewriteGlobalRenames(body, renames) },
            ]),
          )
        : cells;
    }
  }
  for (const { kind, from } of renames) delete next[kind][from];
  for (const { kind, name, change } of choices) if (change === 'removed') delete next[kind][name];

  for (const { id, kind, name, change, languages: cells } of choices) {
    if (change === 'removed') continue;
    const definition = { ...(published.saved.get(id) ?? next[kind][name]) };
    for (const lang of languages) {
      const cell = cells[lang];
      if (!cell) continue;
      if (cell.after === null || cell.afterAvailable === false) delete definition[lang];
      else definition[lang] = { body: cell.after };
    }
    next[kind][name] = definition;
  }
  const unavailable = {
    variables: new Set<string>(),
    titles: new Set<string>(),
    exports: new Set<string>(),
  };
  for (const entry of bundle.globalsPending ?? [])
    if (unpublishedName(entry) && !Object.hasOwn(next[entry.kind], entry.name))
      unavailable[entry.kind].add(entry.name);
  return { definitions: next, unavailable, renames };
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
      .map((entry) => [`${entry.part!.kind}:${entry.name}`, entry]),
  );
  if (!fresh.size) return [];
  const included = new Set(chosen);
  const selected = new Set(chosen.map(({ tooltip }) => tooltip.hash));
  let options = reviewDefinitions(data.bundle, 'next', selected);
  const needed: { global: PendingTooltip; by: PendingTooltip }[] = [];
  for (const by of included) {
    if (by.inactiveChange === 'remove') continue;
    for (let found = true; found;) {
      found = false;
      // The publisher's own reading of the text, and its reason when a name is not published.
      const reason = refusalOf(by, options);
      const global = reason && fresh.get(`${reason.kind}:${reason.globalName}`);
      if (global && !included.has(global)) {
        included.add(global);
        selected.add(global.tooltip.hash);
        options = reviewDefinitions(data.bundle, 'next', selected);
        needed.push({ global, by });
        found = true;
      }
    }
  }
  return needed;
}

function refusalOf({ tooltip, part }: PendingTooltip, options: GlobalsInPlaceOptions) {
  try {
    if (!part?.pending) exportLegacy([tooltip], 0, undefined, {}, { globalsInPlace: options });
    else
      for (const lang of languages) {
        const text = tooltip.text[lang]?.text;
        if (text) resolveGlobalsInPlace(text, lang, options);
      }
  } catch (reason) {
    const cause = reason instanceof Error && part?.pending === undefined ? reason.cause : reason;
    if (cause instanceof UnpublishedGlobal) return cause;
  }
}

/**
 * A tooltip's text as it publishes in a language: its globals filled in as published, and English
 * as a whole where one of them has no current translation.
 */
export function publishedCell(
  data: EditorData | null,
  tooltip: Tooltip | null,
  lang: Lang,
  side: 'live' | 'next',
  selected?: ReadonlySet<number>,
): { text: string; language: Lang } {
  const text = exportedText(tooltip, lang);
  if (!data?.bundle.globalsPending || !tooltip || tooltip.hash < 0) return { text, language: lang };
  const { options } = reviewImportOptions(data, side, selected);
  try {
    const exported = exportLegacy([tooltip], 0, undefined, {}, { globalsInPlace: options })[
      tooltip.hash
    ];
    const cell = exported && !isLegacyAliasStub(exported) ? exported.editor[lang] : undefined;
    if (cell) return { text: cell.main, language: cell.englishFallback ? 'en' : lang };
  } catch {
    // Leave invalid source visible in Review so the author can fix it.
  }
  return { text, language: lang };
}

export const publishedText = (...args: Parameters<typeof publishedCell>) =>
  publishedCell(...args).text;

function reviewImportOptions(
  data: EditorData,
  side: 'live' | 'next',
  selected?: ReadonlySet<number>,
) {
  const { renames, ...definitions } = reviewDefinitions(data.bundle, side, selected);
  const source = (hash: number) => {
    const canonical = resolveAlias(hash, data.aliases);
    const draft = side === 'next' && selected?.has(canonical) && data.bundle.tooltips[canonical];
    if (draft) return { document: draft, draft: true };
    const published = data.bundle.globalsReviewImports?.[hash];
    if (published)
      return { document: renames.length ? rewriteTooltipGlobals(published, renames) : published };
  };
  return { options: withImportedGlobalsFallback(definitions, source), source };
}

/** A filled cell and its numeric imports use the same definitions and source selection. */
export function publishedGlobals(
  globals: MarkupGlobals,
  data: EditorData | null,
  lang: Lang,
  side: 'live' | 'next' = 'next',
  selected?: ReadonlySet<number>,
): MarkupGlobals {
  if (!data?.bundle.globalsPending) return globals;
  const { options, source } = reviewImportOptions(data, side, selected);
  const imports = new Map<number, string | undefined>();
  const read = (hash: number) => {
    if (!imports.has(hash)) {
      const input = source(hash);
      let text: string | undefined;
      try {
        const row =
          input &&
          exportLegacy(
            [input.document],
            0,
            undefined,
            {},
            {
              globalsInPlace: input.draft ? options : { ...options, unavailable: undefined },
            },
          )[input.document.hash];
        text = row && !isLegacyAliasStub(row) ? row.editor[lang]?.main : undefined;
      } catch {
        // An unrenderable source remains unresolved in the preview.
      }
      imports.set(hash, text);
    }
    return imports.get(hash);
  };
  return {
    ...globals,
    lang,
    variables: globalsInPlaceLibraryText(2)!,
    titles: '',
    imports: new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === 'string' && /^\d+$/.test(name) ? read(Number(name)) : undefined,
      },
    ),
  };
}
