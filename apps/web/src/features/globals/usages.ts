import {
  enhancedArrowMarkup,
  enhancedMarkupType,
  globalReferenceSpans,
  languages,
  markupCommentContext,
  parseMarkup,
  resolveAlias,
  variableReferences,
  type GlobalKind,
  type GlobalRecord,
  type Lang,
  type MarkupGlobals,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { importGlobals } from '../../services/tooltipImports';
import { canonicalHash } from '../navigation/catalog';
import { referenceInLine } from '../editor/references';

/**
 * Which tooltips and globals use a global, observed from the real resolver over the loaded
 * data, without changing what it prepares. Each document is rendered once (`parseMarkup`, under
 * each condition type) with core's own observers: variable lookups (`onVariable`), import
 * catalogue reads, and rendered title spans name the candidates. Each candidate is then
 * confirmed by rendering with only that declaration removed: it is used where the output
 * changes. Authored tokens only decide whether a use is written in the text itself (Direct) or
 * comes through something else.
 */

/** Condition types the resolver keeps blocks for (core's `markupConditions`), and none. */
const conditionTypes = [
  undefined,
  enhancedMarkupType,
  'Weapon Catalyst Exotic',
  'Weapon Perk Exotic',
] as const;
type Key = `${GlobalKind}:${string}`;
const keyOf = (kind: GlobalKind, name: string): Key => `${kind}:${name}`;

export interface GlobalUse {
  langs: Lang[];
  /** Written in this text itself (otherwise only through `via`). */
  direct: boolean;
  /** What brings it in when it is not written here, e.g. `[G_range]` or `import Perk from 42`. */
  via: string[];
}
export interface TooltipUse extends GlobalUse {
  /** Canonical hash: an alias group (or base and enhanced versions) is one row. */
  hash: number;
  /** Where the editor opens: the member, language, and line of one use, kept together. */
  open: { variant: number; lang: Lang; line?: number };
  /** Items in the group, the canonical one included. */
  members: number;
}
export interface EntryUse extends GlobalUse {
  id: string;
}
export interface GlobalUsages {
  tooltips: TooltipUse[];
  globals: EntryUse[];
}
export interface GlobalUsageIndex {
  of(id: string): GlobalUsages;
}

const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Runs `work` over `items` in slices of about 8 ms, so no task runs long. */
async function sliced<T>(items: readonly T[], work: (item: T) => void, signal?: AbortSignal) {
  let started = performance.now();
  for (const item of items) {
    if (performance.now() - started > 8) {
      await yieldToPaint();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      started = performance.now();
    }
    work(item);
  }
}

/** Globals written in `text` itself, with the line of the first token of each. */
function authored(text: string): Map<Key, number> {
  const found = new Map<Key, number>();
  text = text.replace(/\r/g, '');
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  const add = (key: Key, offset: number) => {
    if (!found.has(key)) found.set(key, lineAt(offset));
  };
  // Every `#name` outside comments, link labels included (they render too).
  if (text.includes('#')) {
    const { comments } = markupCommentContext(text);
    for (const ref of variableReferences(text))
      if (!comments.some((range) => ref.from >= range.from && ref.to <= range.to))
        add(keyOf('variables', ref.name), ref.from);
  }
  // The arrow symbol is the global variable e.
  if (text.includes(enhancedArrowMarkup)) add('variables:e', text.indexOf(enhancedArrowMarkup));
  for (const kind of ['titles', 'exports'] as const)
    for (const span of globalReferenceSpans(text, kind)) add(keyOf(kind, span.name), span.from);
  return found;
}

/** `import <name> from <source>` lines, read with the editor's own reference code. */
function importsOf(text: string): { name: string; source: string }[] {
  if (!text.includes('import ')) return [];
  const found: { name: string; source: string }[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const ref = line.startsWith('import ') ? referenceInLine(line, 'import '.length) : null;
    if (ref?.kind === 'import') found.push({ name: ref.name, source: ref.source! });
  }
  return found;
}

/**
 * Builds the index over the loaded tooltips (slice by slice, so it never blocks a frame) and
 * the live entries' bodies. Saved text only: drafts never change it.
 */
export async function buildGlobalUsageIndex(
  data: EditorData,
  entries: readonly GlobalRecord[],
  signal?: AbortSignal,
): Promise<GlobalUsageIndex> {
  const live = entries.filter((entry) => !entry.tombstone);
  const ids = new Map(live.map((entry) => [keyOf(entry.kind, entry.name), entry.id]));
  const bodyOf = (entry: GlobalRecord, lang: Lang) =>
    (entry.definitions[lang] ?? entry.definitions.en)?.body;

  // The globals of one language as the resolver reads them, optionally without one declaration.
  const declared = new Map<string, MarkupGlobals>();
  const globalsFor = (lang: Lang, without?: GlobalRecord): MarkupGlobals => {
    const cacheKey = `${lang}:${without?.id ?? ''}`;
    let globals = declared.get(cacheKey);
    if (globals) return globals;
    const write = (kind: GlobalKind, declare: (name: string, body: string) => string) =>
      live
        .filter((entry) => entry !== without && entry.kind === kind)
        .flatMap((entry) => {
          const body = bodyOf(entry, lang);
          return body === undefined ? [] : [declare(entry.name, body)];
        })
        .join(kind === 'variables' ? '\n' : '\n\n');
    const exports = write('exports', (name, body) => `export ${name} (\n${body}\n)`);
    const catalogue = importGlobals(data, {}, lang).imports ?? {};
    globals = {
      variables: write(
        'variables',
        (name, body) => `var ${name} = ${body === '' ? 'empty' : body}`,
      ),
      titles: write('titles', (name, body) => `title ${name} (\n${body}\n)`),
      // The global exports come from the entries; every tooltip is the editor's own catalogue.
      imports: new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, key) =>
            key === '1' || key === 'global'
              ? exports
              : typeof key === 'string'
                ? catalogue[key]
                : undefined,
        },
      ),
    };
    declared.set(cacheKey, globals);
    return globals;
  };
  // One parse is the unit of work: the build yields between parses once a slice reaches 8 ms.
  let slice = performance.now();
  const render = async (text: string, globals: MarkupGlobals) => {
    const rendered: string[] = [];
    for (const type of conditionTypes) {
      if (performance.now() - slice > 8) {
        await yieldToPaint();
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        slice = performance.now();
      }
      rendered.push(JSON.stringify(parseMarkup(text, { ...globals, type }).lines));
    }
    return rendered;
  };
  /** Globals the rendered output of `text` depends on, under any condition type. */
  const usedBy = async (text: string, lang: Lang, self?: GlobalRecord): Promise<Set<Key>> => {
    const globals = globalsFor(lang);
    const variables = new Set<string>();
    const reads = new Set<string>();
    const baseline = await render(text, {
      ...globals,
      onVariable: (name) => variables.add(name),
      imports: new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, key) => {
            if (typeof key === 'string') reads.add(key);
            return globals.imports![key as string];
          },
        },
      ),
    });
    const titled = baseline.some((rendered) => rendered.includes('"title":'));
    const used = new Set<Key>();
    for (const entry of live) {
      if (entry === self) continue;
      const candidate =
        entry.kind === 'variables'
          ? variables.has(entry.name)
          : entry.kind === 'exports'
            ? reads.has('1') || reads.has('global')
            : titled;
      if (!candidate) continue;
      const without = await render(text, globalsFor(lang, entry));
      if (without.some((rendered, type) => rendered !== baseline[type]))
        used.add(keyOf(entry.kind, entry.name));
    }
    return used;
  };

  const docs: { hash: number; lang: Lang; text: string; used?: Set<Key> }[] = [];
  for (const tooltip of Object.values(data.bundle.tooltips)) {
    if (tooltip.hash >= 1 && tooltip.hash <= 3) continue;
    for (const lang of languages) {
      const text = tooltip.text[lang]?.text;
      if (text) docs.push({ hash: tooltip.hash, lang, text });
    }
  }
  for (const doc of docs) doc.used = await usedBy(doc.text, doc.lang);
  const usedByDoc = new Map(docs.map((doc) => [`${doc.hash}:${doc.lang}`, doc.used!]));
  // A global's own body, rendered as its editor previews it.
  const bodies = live.flatMap((entry) =>
    languages
      .filter((lang) => entry.definitions[lang]?.body)
      .map((lang) => ({ entry, lang, text: entry.definitions[lang]!.body })),
  );
  const usedByEntry = new Map<string, Set<Key>>();
  for (const { entry, lang, text } of bodies)
    usedByEntry.set(`${entry.id}:${lang}`, await usedBy(text, lang, entry));
  const members = new Map<number, number>();
  await sliced(
    Object.keys(data.items),
    (hash) => {
      const canonical = canonicalHash(Number(hash), data);
      members.set(canonical, (members.get(canonical) ?? 0) + 1);
    },
    signal,
  );

  /** What brings `key` into a text that does not write it: an import, or a global it writes. */
  const through = (text: string, lang: Lang, own: Map<Key, number>, key: Key): string[] => {
    const found: string[] = [];
    for (const { name, source } of importsOf(text)) {
      const uses =
        source === 'global' || Number(source) === 1
          ? usedByEntry.get(`${ids.get(keyOf('exports', name))}:${lang}`)
          : usedByDoc.get(`${resolveAlias(Number(source), data.aliases)}:${lang}`);
      if (uses?.has(key)) found.push(`import ${name} from ${source}`);
    }
    for (const written of own.keys()) {
      if (!usedByEntry.get(`${ids.get(written)}:${lang}`)?.has(key)) continue;
      const name = written.slice(written.indexOf(':') + 1);
      found.push(
        written.startsWith('variables:')
          ? `#${name}`
          : written.startsWith('titles:')
            ? `[${name}]`
            : `import ${name} from global`,
      );
    }
    return found;
  };
  const record = (row: GlobalUse, lang: Lang, direct: boolean, paths: () => string[]) => {
    if (!row.langs.includes(lang)) row.langs.push(lang);
    if (direct) row.direct = true;
    else for (const path of paths()) if (!row.via.includes(path)) row.via.push(path);
  };

  const tooltips = new Map<string, Map<number, TooltipUse>>();
  await sliced(
    docs,
    ({ hash, lang, text, used }) => {
      if (!used!.size) return;
      const own = authored(text);
      const canonical = canonicalHash(hash, data);
      for (const key of used!) {
        const id = ids.get(key)!;
        let rows = tooltips.get(id);
        if (!rows) tooltips.set(id, (rows = new Map()));
        let row = rows.get(canonical);
        if (!row) {
          const open = { variant: hash, lang };
          const members_ = members.get(canonical) ?? 1;
          row = { hash: canonical, open, members: members_, langs: [], direct: false, via: [] };
          rows.set(canonical, row);
        }
        const line = own.get(key);
        // The first direct use decides where the row opens: its member, language, and line.
        if (line !== undefined && !row.direct) row.open = { variant: hash, lang, line };
        record(row, lang, line !== undefined, () => through(text, lang, own, key));
      }
    },
    signal,
  );
  const globals = new Map<string, Map<string, EntryUse>>();
  for (const { entry, lang, text } of bodies) {
    const used = usedByEntry.get(`${entry.id}:${lang}`)!;
    if (!used.size) continue;
    const own = authored(text);
    for (const key of used) {
      const id = ids.get(key)!;
      let rows = globals.get(id);
      if (!rows) globals.set(id, (rows = new Map()));
      let row = rows.get(entry.id);
      if (!row) rows.set(entry.id, (row = { id: entry.id, langs: [], direct: false, via: [] }));
      record(row, lang, own.has(key), () => through(text, lang, own, key));
    }
  }
  return {
    of(id) {
      return {
        tooltips: [...(tooltips.get(id)?.values() ?? [])],
        globals: [...(globals.get(id)?.values() ?? [])],
      };
    },
  };
}

const indexes = new WeakMap<EditorData, Map<string, Promise<GlobalUsageIndex>>>();
/**
 * The index for this data and these entries, built once and shared: reopening a global (or
 * another one) never rebuilds it. Keyed by the entries' names and bodies, since each catalogue
 * read is a new array. A failed build is dropped so the next open retries.
 */
export function globalUsageIndex(
  data: EditorData,
  entries: readonly GlobalRecord[],
): Promise<GlobalUsageIndex> {
  const key = JSON.stringify(
    entries
      .filter((entry) => !entry.tombstone)
      .map((entry) => [entry.id, entry.kind, entry.name, entry.definitions]),
  );
  let byEntries = indexes.get(data);
  if (!byEntries) indexes.set(data, (byEntries = new Map()));
  let index = byEntries.get(key);
  if (!index) {
    // Only the latest catalogue is kept per data: after a save the old one is stale.
    byEntries.clear();
    byEntries.set(key, (index = buildGlobalUsageIndex(data, entries)));
    index.catch(() => byEntries!.delete(key));
  }
  return index;
}
