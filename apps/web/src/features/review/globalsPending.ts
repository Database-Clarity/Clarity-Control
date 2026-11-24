import {
  globalsInPlaceDefinitions,
  languages,
  resolveGlobalsInPlace,
  type GlobalsPending,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { GlobalPart } from './globalRows';
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

/**
 * New globals that the chosen rows use and that are not chosen: nothing published holds their text
 * yet, so they publish together. A pending change of a published global is never needed.
 */
export function neededGlobals(
  chosen: readonly PendingTooltip[],
  pending: readonly PendingTooltip[],
  data: EditorData,
): { global: PendingTooltip; by: PendingTooltip }[] {
  const fresh = pending.filter(({ part }) => part?.pending?.change === 'new');
  if (!fresh.length) return [];
  // Only what a text itself names counts, so the other definitions are empty.
  const names = globalsInPlaceDefinitions(data.bundle.globals?.entries ?? []);
  const empty = Object.fromEntries(languages.map((lang) => [lang, { body: '' }]));
  const uses = (tooltip: Tooltip, { kind, name }: GlobalPart) => {
    const definitions = Object.fromEntries(
      Object.entries(names).map(([other, entries]) => [
        other,
        Object.fromEntries(
          Object.keys(entries)
            .filter((entry) => other !== kind || entry !== name)
            .map((entry) => [entry, empty]),
        ),
      ]),
    );
    return languages.some((lang) => {
      const text = exportedText(tooltip, lang);
      if (!text.includes(name)) return false;
      try {
        resolveGlobalsInPlace(text, lang, {
          definitions,
          unavailable: { [kind]: new Set([name]) },
        });
        return false;
      } catch (reason) {
        // The publisher's own reason; a text that fails otherwise is refused when it publishes.
        return String(reason).includes(`Publish the shared change for ${name} first.`);
      }
    });
  };
  const included = new Set(chosen);
  const needed: { global: PendingTooltip; by: PendingTooltip }[] = [];
  for (const by of included)
    for (const global of fresh)
      if (!included.has(global) && uses(by.tooltip, global.part!)) {
        included.add(global);
        needed.push({ global, by });
      }
  return needed;
}

/** What tooltips publish with: a global's pending change shows in its own row only. */
export function publishedGlobals(
  globals: MarkupGlobals,
  pending: GlobalsPending | undefined,
  lang: Lang,
): MarkupGlobals {
  // The last declaration of a name wins. A new global publishes with its tooltip, and a renamed
  // one keeps its text.
  const published = (
    kind: PendingGlobal['kind'],
    declare: (name: string, text: string) => string,
  ) =>
    (pending ?? []).flatMap((entry) => {
      const text = entry.languages[lang]?.before;
      return entry.kind === kind && entry.change !== 'renamed' && typeof text === 'string'
        ? [`\n${declare(entry.name, text)}`]
        : [];
    });
  const variables = published('variables', (name, text) => `var ${name} = ${text || 'empty'}`);
  const titles = published('titles', (name, text) => `title ${name} (\n${text}\n)`);
  const exports = published('exports', (name, text) => `export ${name} (\n${text}\n)`);
  if (!variables.length && !titles.length && !exports.length) return globals;
  const library = (hash: string) => (globals.imports?.[hash] ?? '') + exports.join('');
  return {
    ...globals,
    variables: globals.variables + variables.join(''),
    titles: globals.titles + titles.join(''),
    imports: exports.length
      ? Object.assign(Object.create(globals.imports ?? null) as Record<string, string>, {
          1: library('1'),
          global: library('1'),
        })
      : globals.imports,
  };
}
