import {
  extractBlocks,
  languages,
  isMovedInactive,
  type InactiveMoves,
  resolveAlias,
  selectedInactiveMoves,
  validateTextWithReads,
  usesEnglishFallback,
  type Aliases,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import { globalAggregates } from '../../services/globalsFlag';

const textIn = (tooltip: Tooltip, lang: Lang) =>
  usesEnglishFallback(tooltip, lang) ? tooltip.text.en?.text : tooltip.text[lang]?.text;

/** Observe real resolver reads, including aliases, nested imports, and prepared titles. */
function tooltipReads(
  tooltips: Record<string, Tooltip>,
  aliases: Aliases,
  readers: readonly Tooltip[],
  read: (reader: number, source: number, canonical: number) => void,
  changes?: {
    saved: readonly Tooltip[];
    beforeEdit: (source: number, reader: number) => void;
  },
) {
  for (const tooltip of readers)
    for (const hash of tooltip.associated) {
      read(tooltip.hash, hash, resolveAlias(hash, aliases));
    }
  const saved = new Map(changes?.saved.map((tooltip) => [tooltip.hash, tooltip]));
  for (const lang of languages) {
    const replacements = new Map<number, string>();
    for (const [hash, tooltip] of saved) {
      const before = tooltips[hash] && textIn(tooltips[hash], lang);
      if (!before?.includes('export ')) continue;
      const after = textIn(tooltip, lang) ?? '';
      if (before === after) continue;
      const exports = extractBlocks(after, 'export');
      if (
        Object.keys(extractBlocks(before, 'export')).some((name) => !Object.hasOwn(exports, name))
      )
        replacements.set(hash, after);
    }
    let replacing: number | undefined;
    const imports = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) => {
          const hash = typeof key === 'string' ? Number(key) : NaN;
          if (hash === replacing) return replacements.get(hash);
          const t = tooltips[hash];
          return t ? (textIn(t, lang) ?? '') : undefined;
        },
      },
    );
    // Alias resolution is also needed for the catalogue lookups performed by the resolver.
    const catalog = new Proxy(imports, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined;
        return target[resolveAlias(key === 'global' ? 1 : Number(key), aliases)];
      },
    });
    for (const tooltip of readers) {
      const text = textIn(tooltip, lang);
      if (text === undefined) continue;
      const validate = () =>
        validateTextWithReads(
          text,
          lang,
          { imports: catalog, variables: catalog[2] ?? '', titles: catalog[3] ?? '' },
          false,
          tooltip.hash,
          aliases,
        );
      const { reads, issues } = validate();
      for (const [source, hash] of reads.imports)
        read(tooltip.hash, source === 'global' ? 1 : Number(source), hash);
      // Test the exported edit against the live reader. A disappearing export that the reader
      // actually uses must wait for that reader's repair, even if the saved reader imports it too.
      if (changes && replacements.size)
        for (const hash of new Set(reads.imports.values())) {
          if (hash === tooltip.hash || !replacements.has(hash)) continue;
          replacing = hash;
          const edited = validate();
          replacing = undefined;
          if (
            edited.issues.some(
              ({ message }) =>
                message.startsWith('Unresolved import "') &&
                !issues.some((issue) => issue.message === message),
            )
          )
            changes.beforeEdit(hash, tooltip.hash);
        }
    }
  }
}

interface PublishDependencyOptions {
  moves?: InactiveMoves;
  globals?: boolean;
  /** Ready Review comparisons. A row without a marker has an explicit undefined value. */
  published?: Readonly<Partial<Record<number, Tooltip | null | undefined>>>;
}

export function publishDependencies(
  tooltips: Record<string, Tooltip>,
  aliases: Aliases,
  pending: ReadonlySet<number>,
  selected: readonly Tooltip[],
  { moves = {}, globals = false, published = {} }: PublishDependencyOptions = {},
): Map<number, number[]> {
  const result = new Map<number, Set<number>>(selected.map((t) => [t.hash, new Set()]));
  const active = selected.filter((tooltip) => !isMovedInactive(tooltip.hash, moves));
  tooltipReads(tooltips, aliases, active, (reader, _source, hash) => {
    if (pending.has(hash)) result.get(reader)!.add(hash);
  });
  // Without per-entry release, the aggregate bodies are inputs even without a numeric lookup.
  if (!globals)
    for (const tooltip of active)
      for (const hash of globalAggregates)
        if (pending.has(hash)) result.get(tooltip.hash)!.add(hash);

  const removedBy = new Map<number, number>();
  for (const key of Object.keys(selectedInactiveMoves(moves, result.keys(), aliases))) {
    const hash = Number(key);
    if (isMovedInactive(hash, moves)) removedBy.set(hash, resolveAlias(hash, aliases));
  }
  if (removedBy.size) {
    // Older live rows can predate their pushed marker. The comparison endpoint cannot tell
    // them apart from new rows, so keep them with the removals they might still read.
    const uncertain = new Set(
      selected
        .map(({ hash }) => hash)
        .filter((hash) => Object.hasOwn(published, hash) && published[hash] === undefined),
    );
    const live = { ...tooltips };
    for (const [key, tooltip] of Object.entries(published)) {
      if (tooltip) live[key] = tooltip;
      else if (tooltip === null) delete live[key];
    }
    tooltipReads(
      live,
      aliases,
      selected.flatMap(({ hash }) => (published[hash] ? [published[hash]] : [])),
      (reader, source, hash) => {
        for (const target of [removedBy.get(source), removedBy.get(hash)])
          if (target !== undefined && target !== reader) result.get(target)!.add(reader);
        // The archived source stores raw references; the live export may have used an alias
        // that no longer exists. Only a read of the sole removal key can be ordered directly.
        if (![1, 2, 3].includes(source) && !(removedBy.size === 1 && removedBy.has(source)))
          uncertain.add(reader);
      },
      { saved: active, beforeEdit: (source, reader) => result.get(source)!.add(reader) },
    );
    // Keep possible readers with the removals they could reference. Link them through one
    // member to keep the edges linear.
    const [first, ...rest] = uncertain.size ? new Set([...removedBy.values(), ...uncertain]) : [];
    if (first !== undefined) {
      for (const hash of rest) {
        result.get(first)!.add(hash);
        result.get(hash)!.add(first);
      }
    }
  }
  return new Map([...result].map(([hash, deps]) => [hash, [...deps]]));
}
