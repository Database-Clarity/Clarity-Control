import { z } from 'zod';
import { resolveAlias, type Aliases } from './aliases.js';
import { stableStringify } from './contentHash.js';
import { exportLegacy, usesEnglishFallback, type LegacyExportEntry } from './exportLegacy.js';
import { languages } from './languages.js';
import type { LegacyCatalog } from './legacy.js';
import { lowerConsumerMarkup } from './markup/braces.js';
import { publishableHash } from './publishableHash.js';
import type { Tooltip } from './schemas.js';
import { validateTextWithReads } from './validation/index.js';

export const inactiveMovesPath = 'config/inactive.json';
export const inactiveMovesCapability = 'inactiveMoves';
export const inactiveHashKey = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number(value) <= 0xffffffff);
export const inactiveMovesSchema = z.record(
  inactiveHashKey,
  z
    .object({
      by: z.number().int().positive(),
      at: z.string().datetime({ offset: true }),
      note: z.string().trim().max(1000).optional(),
      /** Retain a move-out marker so a partial publish can restore this item's stubs. */
      inactive: z.literal(false).optional(),
    })
    .strict(),
);
export type InactiveMoves = z.infer<typeof inactiveMovesSchema>;

/** Item identity is deliberate: moving an alias suppresses that stub alone. */
export function isMovedInactive(hash: number, moves: InactiveMoves | undefined): boolean {
  return !!moves && Object.hasOwn(moves, String(hash)) && moves[String(hash)]?.inactive !== false;
}

/** Only a selected canonical row publishes its own move and the decisions for its stubs. */
export function selectedInactiveMoves(
  moves: InactiveMoves,
  hashes: Iterable<number>,
  aliases: Aliases,
): InactiveMoves {
  const selected = new Set(hashes);
  return Object.fromEntries(
    Object.entries(moves).filter(([hash]) => selected.has(resolveAlias(Number(hash), aliases))),
  );
}

/** Empty files preserve old digests; active rows change when their incoming stubs change. */
export async function inactivePublishableHash(
  tooltip: Tooltip,
  aliases: Aliases,
  moves: InactiveMoves = {},
): Promise<string> {
  if (isMovedInactive(tooltip.hash, moves)) {
    return inactiveRemovalHash(tooltip.hash);
  }
  return publishableHash(tooltip, activeAliases(aliases, moves));
}

/** Stable published removal marker, including for an item with no stored tooltip. */
export async function inactiveRemovalHash(hash: number): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify({ inactive: hash }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const activeAliasSnapshots = new WeakMap<Aliases, WeakMap<InactiveMoves, Aliases>>();
export function activeAliases(aliases: Aliases, moves: InactiveMoves): Aliases {
  const cached = activeAliasSnapshots.get(aliases)?.get(moves);
  if (cached) return cached;
  const keys = Object.keys(moves);
  if (!keys.some((key) => isMovedInactive(Number(key), moves))) return aliases;
  const active = Object.fromEntries(
    Object.entries(aliases)
      .filter(
        ([key]) =>
          !isMovedInactive(Number(key), moves) &&
          !isMovedInactive(resolveAlias(Number(key), aliases), moves),
      )
      .map(([key, value]) => {
        // Removing an intermediate alias must not change another stub's canonical identity.
        const to = resolveAlias(Number(key), aliases);
        return [key, to === value.to ? value : { ...value, to }];
      }),
  );
  let snapshots = activeAliasSnapshots.get(aliases);
  if (!snapshots) activeAliasSnapshots.set(aliases, (snapshots = new WeakMap()));
  snapshots.set(moves, active);
  return active;
}

/**
 * Resolve against the complete source before removing anything. Importers must be moved too,
 * or edited to stop reading the removed text, before the removal can publish. Nested imports,
 * aliases, and title bodies use the real resolver; global documents are required inputs.
 * `moves` is the candidate's published state, not every staged move in editor data. A partial
 * publisher must apply only its selected rows to the live snapshot before calling this helper.
 */
export function exportWithInactiveMoves(
  tooltips: readonly Tooltip[],
  now: number,
  catalog?: LegacyCatalog,
  aliases: Aliases = {},
  moves: InactiveMoves = {},
): Record<string, LegacyExportEntry> {
  if (!Object.keys(moves).some((hash) => isMovedInactive(Number(hash), moves)))
    return exportLegacy(tooltips, now, catalog, aliases);
  for (const hash of [1, 2, 3])
    if (isMovedInactive(hash, moves))
      throw new Error(
        `Global tooltip ${hash} is a required output input; move it out of Inactive before publishing`,
      );
  const kept = tooltips.filter((tooltip) => !isMovedInactive(tooltip.hash, moves));
  for (const language of languages) {
    const imports = Object.fromEntries(
      tooltips.map((tooltip) => {
        const text = usesEnglishFallback(tooltip, language)
          ? tooltip.text.en
          : tooltip.text[language];
        return [tooltip.hash, lowerConsumerMarkup(text?.text ?? '')];
      }),
    );
    for (const alias of Object.keys(aliases))
      imports[alias] = imports[resolveAlias(Number(alias), aliases)] ?? '';
    for (const tooltip of kept) {
      for (const hash of tooltip.associated)
        if (isMovedInactive(hash, moves) || isMovedInactive(resolveAlias(hash, aliases), moves))
          throw new Error(`Tooltip ${tooltip.hash} associates inactive tooltip ${hash}`);
      const text = imports[tooltip.hash];
      if (!text) continue;
      const { reads } = validateTextWithReads(
        text,
        language,
        {
          imports,
          variables: imports[2] ?? '',
          titles: imports[3] ?? '',
        },
        false,
        tooltip.hash,
        aliases,
      );
      for (const [key, hash] of reads.imports)
        if (isMovedInactive(hash, moves) || isMovedInactive(Number(key), moves))
          throw new Error(`Tooltip ${tooltip.hash} imports inactive tooltip ${hash} (${language})`);
    }
  }
  // Keep the original alias map for canonical identity checks, then suppress moved stubs.
  const entries = exportLegacy(kept, now, catalog, aliases);
  for (const hash of Object.keys(moves))
    if (isMovedInactive(Number(hash), moves)) delete entries[hash];
  return entries;
}
