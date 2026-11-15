import {
  languages,
  isMovedInactive,
  type InactiveMoves,
  resolveAlias,
  validateTextWithReads,
  usesEnglishFallback,
  type Aliases,
  type Tooltip,
} from '@clarity/core';

/** Observe real resolver reads; never guess dependencies by parsing import lines ourselves. */
export function publishDependencies(
  tooltips: Record<string, Tooltip>,
  aliases: Aliases,
  pending: ReadonlySet<number>,
  selected: readonly Tooltip[],
  moves: InactiveMoves = {},
): Map<number, number[]> {
  const result = new Map<number, Set<number>>(selected.map((t) => [t.hash, new Set()]));
  const active = selected.filter((tooltip) => !isMovedInactive(tooltip.hash, moves));
  for (const tooltip of active)
    for (const hash of tooltip.associated) {
      const canonical = resolveAlias(hash, aliases);
      if (pending.has(canonical)) result.get(tooltip.hash)!.add(canonical);
    }
  for (const lang of languages) {
    const imports = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) => {
          const hash = typeof key === 'string' ? Number(key) : NaN;
          const t = tooltips[hash];
          return t
            ? ((usesEnglishFallback(t, lang) ? t.text.en?.text : t.text[lang]?.text) ?? '')
            : undefined;
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
    for (const tooltip of active) {
      const deps = result.get(tooltip.hash)!;
      const text = usesEnglishFallback(tooltip, lang)
        ? tooltip.text.en?.text
        : tooltip.text[lang]?.text;
      if (text === undefined) continue;
      const { reads } = validateTextWithReads(
        text,
        lang,
        { imports: catalog, variables: catalog[2] ?? '', titles: catalog[3] ?? '' },
        false,
        tooltip.hash,
        aliases,
      );
      for (const hash of reads.imports.values()) if (pending.has(hash)) deps.add(hash);
      // Global preparation can read title/variable bodies without a numeric import lookup.
      // Keep pending global libraries ahead of every consumer, conservatively.
      for (const hash of [1, 2, 3]) if (pending.has(hash)) deps.add(hash);
    }
  }
  const removal = selected.find((tooltip) => isMovedInactive(tooltip.hash, moves));
  if (removal) {
    // A saved importer may already have dropped an import that its live text still reads.
    // Keep the full reviewed selection together; the publisher checks the real live candidate.
    // A hub gives one closed group with linear memory, and existing Worker caps still apply.
    for (const tooltip of selected)
      if (tooltip.hash !== removal.hash) {
        result.get(removal.hash)!.add(tooltip.hash);
        result.get(tooltip.hash)!.add(removal.hash);
      }
  }
  return new Map([...result].map(([hash, deps]) => [hash, [...deps]]));
}
