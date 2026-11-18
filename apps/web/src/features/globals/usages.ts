import {
  enhancedArrowMarkup,
  globalReferenceSpans,
  languages,
  lowerDelimitedMarkup,
  resolveAlias,
  type GlobalKind,
  type GlobalRecord,
  type Lang,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';
import { locateBlocks, referenceInLine } from '../editor/references';

/**
 * Which tooltips and globals use a global, from the loaded data. Direct uses are the authored
 * reference tokens core's `globalReferenceSpans` finds (the same spans a rename rewrites: no
 * comments, link labels, or literal URLs); `import … from <hash>` lines are read with the
 * editor's own `referenceInLine`. Indirect uses follow what the resolver splices in: an imported
 * export block, an `import … from global` export body, a title body, or a variable value.
 */

const kinds: readonly GlobalKind[] = ['variables', 'titles', 'exports'];
type Key = `${GlobalKind}:${string}`;
const keyOf = (kind: GlobalKind, name: string): Key => `${kind}:${name}`;

/**
 * What the resolver resolves inside a spliced body. Variable values are substituted after
 * variable lookup (their own `#refs` stay literal) but before titles; title bodies are prepared
 * with variables and imports but without titles; export bodies become ordinary text.
 */
const follows: Readonly<Record<GlobalKind, { kinds: readonly GlobalKind[]; imports: boolean }>> = {
  variables: { kinds: ['titles'], imports: false },
  titles: { kinds: ['variables', 'exports'], imports: true },
  exports: { kinds, imports: true },
};

interface Refs {
  /** Global references by key, with the 1-based line of the first one. */
  globals: Map<Key, number>;
  /** `import <name> from <hash>` of another tooltip. */
  imports: { hash: number; name: string; line: number }[];
}

function refsOf(text: string): Refs {
  const globals = new Map<Key, number>();
  const imports: Refs['imports'] = [];
  if (!text) return { globals, imports };
  text = text.replace(/\r/g, '');
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
    starts.push(index + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  for (const kind of kinds) {
    if (kind === 'variables' && !text.includes('#')) continue;
    if (kind === 'titles' && !text.includes('<title')) continue;
    if (kind === 'exports' && !text.includes('import ')) continue;
    for (const span of globalReferenceSpans(text, kind)) {
      const key = keyOf(kind, span.name);
      if (!globals.has(key)) globals.set(key, lineAt(span.from));
    }
  }
  // The arrow symbol is the global variable e: the resolver reads `<enhanced/>` as `#e`.
  if (text.includes(enhancedArrowMarkup) && !globals.has('variables:e')) {
    const lowered = globalReferenceSpans(lowerDelimitedMarkup(text), 'variables');
    if (lowered.some((span) => span.name === 'e'))
      globals.set('variables:e', lineAt(text.indexOf(enhancedArrowMarkup)));
  }
  if (text.includes('import '))
    text.split('\n').forEach((line, index) => {
      if (!line.startsWith('import ')) return;
      const ref = referenceInLine(line, 'import '.length);
      if (ref?.kind !== 'import' || ref.source === 'global' || Number(ref.source) === 1) return;
      imports.push({ hash: Number(ref.source), name: ref.name, line: index + 1 });
    });
  return { globals, imports };
}

export interface GlobalUse {
  langs: Lang[];
  /** Written in this text itself (otherwise only through `via`). */
  direct: boolean;
  /** What brings it in when it is not direct, e.g. `[G_range]` or `import Perk from 42`. */
  via: string[];
  /** First line of a direct use, in the first language. */
  line?: number;
}
export interface TooltipUse extends GlobalUse {
  /** Canonical hash: an alias group (or base and enhanced versions) is one row. */
  hash: number;
  /** The tooltip version the use was found in, for the editor's `variant`. */
  variant: number;
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

interface Docs {
  data: EditorData;
  docs: { hash: number; lang: Lang; refs: Refs }[];
  members: Map<number, number>;
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

const docCache = new WeakMap<EditorData, Promise<Docs>>();
function loadDocs(data: EditorData): Promise<Docs> {
  let docs = docCache.get(data);
  if (!docs) {
    docs = (async () => {
      const result: Docs = { data, docs: [], members: new Map() };
      await sliced(Object.values(data.bundle.tooltips), (tooltip) => {
        if (tooltip.hash >= 1 && tooltip.hash <= 3) return;
        for (const lang of languages) {
          const text = tooltip.text[lang]?.text;
          if (text) result.docs.push({ hash: tooltip.hash, lang, refs: refsOf(text) });
        }
      });
      await sliced(Object.keys(data.items), (hash) => {
        const canonical = canonicalHash(Number(hash), data);
        result.members.set(canonical, (result.members.get(canonical) ?? 0) + 1);
      });
      return result;
    })();
    docCache.set(data, docs);
    docs.catch(() => docCache.delete(data));
  }
  return docs;
}

interface Found {
  direct: boolean;
  via?: string;
  line?: number;
}

/** Every global key a text uses, directly or through what the resolver splices into it. */
function closure(
  start: Refs,
  lang: Lang,
  allowed: { kinds: readonly GlobalKind[]; imports: boolean },
  bodies: Map<Key, Partial<Record<Lang, string>>>,
  data: EditorData,
  blocks: Map<string, Refs>,
): Map<Key, Found> {
  const found = new Map<Key, Found>();
  const seen = new Set<string>();
  const queue: { refs: Refs; via?: string; allowed: typeof allowed }[] = [{ refs: start, allowed }];
  while (queue.length) {
    const { refs, via, allowed } = queue.shift()!;
    for (const [key, line] of refs.globals) {
      const kind = key.slice(0, key.indexOf(':')) as GlobalKind;
      const definitions = bodies.get(key);
      if (!definitions || !allowed.kinds.includes(kind)) continue;
      const previous = found.get(key);
      if (!previous || (!previous.direct && !via))
        found.set(key, via ? { direct: false, via } : { direct: true, line });
      if (seen.has(key)) continue;
      seen.add(key);
      const body = definitions[lang] ?? definitions.en;
      if (body) {
        const name = key.slice(key.indexOf(':') + 1);
        queue.push({
          refs: blockRefs(`${key}:${lang}`, () => body, blocks),
          via:
            via ??
            (kind === 'variables'
              ? `#${name}`
              : kind === 'titles'
                ? `[${name}]`
                : `import ${name} from global`),
          allowed: follows[kind],
        });
      }
    }
    if (!allowed.imports) continue;
    for (const { hash, name } of refs.imports) {
      const id = `import:${hash}:${name}:${lang}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const refs = blockRefs(
        id,
        () => {
          const tooltip = data.bundle.tooltips[resolveAlias(hash, data.aliases)];
          const text = (tooltip?.text[lang] ?? tooltip?.text.en)?.text ?? '';
          return name === 'main' || name === 'secondary'
            ? text
            : locateBlocks(text.replace(/\r/g, ''), 'export').get(name)?.value;
        },
        blocks,
      );
      queue.push({ refs, via: via ?? `import ${name} from ${hash}`, allowed: follows.exports });
    }
  }
  return found;
}

function blockRefs(id: string, text: () => string | undefined, blocks: Map<string, Refs>): Refs {
  let refs = blocks.get(id);
  if (!refs) blocks.set(id, (refs = refsOf(text() ?? '')));
  return refs;
}

function addUse<T extends GlobalUse>(
  uses: Map<string, T>,
  id: string,
  lang: Lang,
  use: Found,
  create: () => Omit<T, keyof GlobalUse>,
) {
  let row = uses.get(id);
  if (!row)
    uses.set(id, (row = { ...create(), langs: [], direct: false, via: [] } as unknown as T));
  if (!row.langs.includes(lang)) row.langs.push(lang);
  if (use.direct) {
    if (!row.direct) row.line = use.line;
    row.direct = true;
  } else if (use.via && !row.via.includes(use.via)) row.via.push(use.via);
}

export interface GlobalUsageIndex {
  of(id: string): GlobalUsages;
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
  const { docs, members } = await loadDocs(data);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const live = entries.filter((entry) => !entry.tombstone);
  const ids = new Map(live.map((entry) => [keyOf(entry.kind, entry.name), entry.id]));
  const bodies = new Map(
    live.map((entry) => [
      keyOf(entry.kind, entry.name),
      Object.fromEntries(
        Object.entries(entry.definitions).map(([lang, definition]) => [lang, definition?.body]),
      ) as Partial<Record<Lang, string>>,
    ]),
  );
  const blocks = new Map<string, Refs>();
  const tooltips = new Map<string, Map<string, TooltipUse>>();
  const globals = new Map<string, Map<string, EntryUse>>();
  const usesOf = <T>(index: Map<string, Map<string, T>>, id: string) => {
    let uses = index.get(id);
    if (!uses) index.set(id, (uses = new Map()));
    return uses;
  };
  const all = { kinds, imports: true };
  await sliced(
    docs,
    ({ hash, lang, refs }) => {
      for (const [key, use] of closure(refs, lang, all, bodies, data, blocks)) {
        const canonical = canonicalHash(hash, data);
        addUse(usesOf(tooltips, ids.get(key)!), String(canonical), lang, use, () => ({
          hash: canonical,
          variant: hash,
          members: members.get(canonical) ?? 1,
        }));
      }
    },
    signal,
  );
  for (const entry of live)
    for (const [lang, body] of Object.entries(bodies.get(keyOf(entry.kind, entry.name))!)) {
      if (!body) continue;
      const refs = blockRefs(`${entry.kind}:${entry.name}:${lang}`, () => body, blocks);
      for (const [key, use] of closure(
        refs,
        lang as Lang,
        follows[entry.kind],
        bodies,
        data,
        blocks,
      ))
        if (ids.get(key) !== entry.id)
          addUse(usesOf(globals, ids.get(key)!), entry.id, lang as Lang, use, () => ({
            id: entry.id,
          }));
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
