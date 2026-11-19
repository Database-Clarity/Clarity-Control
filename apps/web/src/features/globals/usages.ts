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
 * data: every document is parsed (`parseMarkup`, under each condition type) with each global's
 * definition prefixed by its own marker, and a global is used where its marker reaches the
 * output. Imports, export and title bodies, variable values, conditions, the five-pass import
 * limit, comments, and link labels all count exactly as they render. Authored tokens only
 * decide whether a use is written in the text itself (Direct) or comes through something else.
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
/** Letters only, between brackets no name can hold: nothing merges with or formats them. */
const markerOf = (index: number) =>
  `⦃${[...index.toString(26)].map((digit) => String.fromCharCode(97 + parseInt(digit, 26))).join('')}⦄`;
const markerPattern = /⦃[a-z]+⦄/g;

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
  const keys = new Map(
    live.map((entry, index) => [markerOf(index), keyOf(entry.kind, entry.name)]),
  );
  const bodyOf = (entry: GlobalRecord, lang: Lang) =>
    (entry.definitions[lang] ?? entry.definitions.en)?.body;

  // Marked globals per language: each definition starts with its marker, the rest unchanged.
  const marked = new Map<Lang, MarkupGlobals>();
  const globalsFor = (lang: Lang) => {
    let globals = marked.get(lang);
    if (globals) return globals;
    const declared = (kind: GlobalKind, write: (name: string, body: string) => string) =>
      live
        .map((entry, index) => ({ entry, body: bodyOf(entry, lang), marker: markerOf(index) }))
        .filter(({ entry, body }) => entry.kind === kind && body !== undefined)
        .map(({ entry, body, marker }) => write(entry.name, marker + body))
        .join(kind === 'variables' ? '\n' : '\n\n');
    const exports = declared('exports', (name, body) => `export ${name} (\n${body}\n)`);
    const catalogue = importGlobals(data, {}, lang).imports ?? {};
    globals = {
      variables: declared('variables', (name, body) => `var ${name} = ${body}`),
      titles: declared('titles', (name, body) => `title ${name} (\n${body}\n)`),
      // The global exports are the marked ones; every tooltip is the editor's own catalogue.
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
    marked.set(lang, globals);
    return globals;
  };
  /** Globals that reach the rendered output of `text`, under any condition type. */
  const usedBy = (text: string, lang: Lang): Set<Key> => {
    const used = new Set<Key>();
    for (const type of conditionTypes) {
      const rendered = JSON.stringify(parseMarkup(text, { ...globalsFor(lang), type }).lines);
      for (const [marker] of rendered.matchAll(markerPattern)) used.add(keys.get(marker)!);
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
  await sliced(docs, (doc) => (doc.used = usedBy(doc.text, doc.lang)), signal);
  const usedByDoc = new Map(docs.map((doc) => [`${doc.hash}:${doc.lang}`, doc.used!]));
  // A global's own body, rendered as its editor previews it.
  const bodies = live.flatMap((entry) =>
    languages
      .filter((lang) => entry.definitions[lang]?.body)
      .map((lang) => ({ entry, lang, text: entry.definitions[lang]!.body })),
  );
  const usedByEntry = new Map<string, Set<Key>>();
  await sliced(
    bodies,
    ({ entry, lang, text }) => {
      const used = usedBy(text, lang);
      used.delete(keyOf(entry.kind, entry.name));
      usedByEntry.set(`${entry.id}:${lang}`, used);
    },
    signal,
  );
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
