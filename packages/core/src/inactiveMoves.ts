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

export const unreviewedInactiveMessage =
  'Publish inactive move decisions in Review changes before scheduling or publishing this batch';

/** A text batch has no inactive intent: only an already published move may affect its output. */
export async function hasUnpublishedInactiveMove(
  hash: number,
  snapshot: Tooltip | null,
  pushed: string | undefined,
  aliases: Aliases,
  moves: InactiveMoves,
): Promise<boolean> {
  if (!Object.keys(selectedInactiveMoves(moves, [hash], aliases)).length) return false;
  if (isMovedInactive(hash, moves) || !snapshot || !pushed) return true;
  return (await inactivePublishableHash(snapshot, aliases, moves)) !== pushed;
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
        if (isMovedInactive(resolveAlias(hash, aliases), moves))
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

/**
 * Apply only the selected rows' decisions to an already merged live candidate. Other staged
 * moves cannot leak into an unrelated publish. Validate retained live text, not saved drafts:
 * an importer must be edited/published, or removed in the same operation, before its target.
 */
export function applyInactiveLive(
  perks: Readonly<Record<string, unknown>>,
  moves: InactiveMoves,
  hashes: Iterable<number>,
  aliases: Aliases,
  previous: Readonly<Record<string, unknown>> = perks,
): Record<string, unknown> {
  if (!Object.keys(moves).length) return perks as Record<string, unknown>;
  const selected = selectedInactiveMoves(moves, hashes, aliases);
  const result = { ...perks };
  const removed = new Set<number>();
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const erase = (hash: number) => {
    delete result[hash];
    removed.add(hash);
  };
  // Pick recomputation can recreate a missing stub. Only its selected canonical row may
  // re-add it; both move-in and move-out markers retain the pre-merge published absence.
  for (const key of Object.keys(moves))
    if (!Object.hasOwn(selected, key) && !Object.hasOwn(previous, key)) erase(Number(key));
  for (const key of Object.keys(selected)) {
    const hash = Number(key);
    if (!isMovedInactive(hash, selected)) continue;
    if ([1, 2, 3].includes(hash))
      throw new Error(`Global tooltip ${hash} is a required output input`);
    erase(hash);
    // A canonical removal also removes old live stubs, even if the generator no longer lists them.
    if (resolveAlias(hash, aliases) === hash)
      for (const [stub, value] of Object.entries(result))
        if (
          (record(value) && value.aliasOf === hash) ||
          (Object.hasOwn(aliases, stub) && resolveAlias(Number(stub), aliases) === hash)
        )
          erase(Number(stub));
  }
  // Move-out markers stay absent until their own row re-adds them. Staged move-ins that are
  // still live remain available to unrelated publishers, exactly as the live file says.
  for (const key of Object.keys(moves)) if (!Object.hasOwn(result, key)) removed.add(Number(key));
  if (!removed.size) return result;
  const liveAliases: Aliases = { ...aliases };
  for (const [key, value] of Object.entries(perks))
    if (record(value) && typeof value.aliasOf === 'number')
      liveAliases[key] = { to: value.aliasOf, kind: 'name' };
  for (const language of languages)
    for (const field of ['main', 'secondary'] as const) {
      const imports: Record<string, string> = {};
      for (const [key, value] of Object.entries(result)) {
        if (!record(value) || 'aliasOf' in value) continue;
        const editor = value.editor;
        if (!record(editor)) throw new Error(`Invalid live tooltip ${key}`);
        const translation = editor[language];
        imports[key] =
          record(translation) && typeof translation[field] === 'string' ? translation[field] : '';
      }
      for (const [key, value] of Object.entries(result))
        if (record(value) && typeof value.aliasOf === 'number')
          imports[key] = imports[value.aliasOf] ?? '';
      for (const [key, value] of Object.entries(result)) {
        if (!record(value) || 'aliasOf' in value) continue;
        if (Array.isArray(value.associated))
          for (const hash of value.associated)
            if (
              typeof hash === 'number' &&
              (removed.has(hash) || removed.has(resolveAlias(hash, liveAliases)))
            )
              throw new Error(`Tooltip ${key} associates inactive tooltip ${hash}`);
        const text = imports[key];
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
          Number(key),
          liveAliases,
        );
        for (const [source, hash] of reads.imports)
          if (removed.has(hash) || removed.has(Number(source)))
            throw new Error(
              `Tooltip ${key} imports inactive tooltip ${hash} (${language}, ${field})`,
            );
      }
    }
  return result;
}
