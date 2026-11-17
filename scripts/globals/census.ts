import { buildGlobalUsageIndex } from '../../packages/core/src/globals/index.js';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import { calculateGlobalImpact } from '../../packages/core/src/globals/impact.js';
import type { GlobalImpactSnapshot } from '../../packages/core/src/globals/impactModel.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import { z } from 'zod';
import { aliasesSchema, resolveAlias } from '../../packages/core/src/aliases.js';
import {
  hashSchema,
  legacyDatabaseSchema,
  legacyPerkSchema,
} from '../../packages/core/src/legacy.js';
import { migrateLegacy } from '../../packages/core/src/migrateLegacy.js';
import type { GlobalInventorySource } from '../../packages/core/src/globals/projection.js';

/** Exported aliases are stubs, never authored tooltips. Preserve their facts for legacy contexts. */
export function legacySnapshot(
  input: unknown,
  source: { repository: string; revision: string; path: string },
) {
  const stub = z
    .object({
      hash: hashSchema,
      aliasOf: hashSchema,
      aliasKind: z.enum(['name', 'frame', 'sandbox']),
      name: z.string().optional(),
      type: z.string().optional(),
      itemHash: hashSchema.optional(),
      itemName: z.string().optional(),
    })
    .strict();
  const raw = z
    .object({
      perks: z.record(
        z.string().regex(/^(0|[1-9]\d*)$/),
        z.union([stub, legacyPerkSchema.extend({ associated: z.array(hashSchema).optional() })]),
      ),
      databaseSettings: legacyDatabaseSchema.shape.databaseSettings,
    })
    .strict()
    .parse(input);
  const aliases = aliasesSchema.parse(
    Object.fromEntries(
      Object.entries(raw.perks)
        .filter(([, value]) => 'aliasOf' in value)
        .map(([key, value]) => [
          key,
          {
            to: (value as z.infer<typeof stub>).aliasOf,
            kind: (value as z.infer<typeof stub>).aliasKind,
          },
        ]),
    ),
  );
  for (const [key, value] of Object.entries(raw.perks)) {
    if (key !== String(value.hash)) throw new Error(`Legacy key/hash mismatch: ${key}`);
    if ('aliasOf' in value && (!raw.perks[value.aliasOf] || 'aliasOf' in raw.perks[value.aliasOf]))
      throw new Error(`Missing canonical live alias target: ${key}`);
    resolveAlias(value.hash, aliases);
  }
  const canonical = Object.fromEntries(
    Object.entries(raw.perks)
      .filter(([, value]) => !('aliasOf' in value))
      .map(([key, value]) => {
        const { associated: _associated, ...perk } = value as z.infer<typeof legacyPerkSchema> & {
          associated?: number[];
        };
        void _associated;
        return [key, perk];
      }),
  );
  const { path, ...identity } = source;
  void path;
  const migrated = migrateLegacy({ ...raw, perks: canonical }).map((tooltip) => {
    const original = raw.perks[tooltip.hash];
    if ('aliasOf' in original) throw new Error('Alias cannot own a published snapshot');
    // Legacy fallback flags cannot be reconstructed as native source timestamps. Refuse
    // that context without a real authored snapshot, rather than silently changing decimals.
    for (const [lang, cell] of Object.entries(original.editor))
      if (cell.englishFallback)
        throw new Error(
          `English-fallback provenance requires a published authored snapshot: ${tooltip.hash}/${lang}`,
        );
    return { ...tooltip, associated: original.associated ?? [] };
  });
  return {
    ...identity,
    tooltips: Object.fromEntries(migrated.map((v) => [v.hash, v])),
    aliases,
    types: Object.fromEntries(
      Object.values(raw.perks)
        .filter(
          (v) =>
            v.type !== undefined ||
            ('aliasOf' in v && [v.name, v.itemHash, v.itemName].some((fact) => fact !== undefined)),
        )
        .map((v) => [v.hash, v.type ?? '']),
    ),
    mode: 'live' as const,
  };
}

export function legacyGlobalsCensus(
  input: unknown,
  source: { repository: string; revision: string; path: string },
) {
  return globalsCensus(legacySnapshot(input, source), (hash, lang) => ({
    path: source.path,
    selector: ['perks', String(hash), 'editor', lang, 'main'],
  }));
}

/** Read-only inventory/parity proposal. No write, migration, or activation option exists. */
export function globalsCensus(
  snapshot: GlobalImpactSnapshot,
  locate: GlobalInventorySource['locate'],
) {
  let counter = 0;
  const store = inventoryGlobals(
    Object.values(snapshot.tooltips).filter((v) => v.hash === 2 || v.hash === 3),
    { repository: snapshot.repository, revision: snapshot.revision, locate },
    () => `g_proposal${String(++counter).padStart(8, '0')}`,
  );
  const projected = { ...snapshot.tooltips, ...projectGlobals(store) };
  const aggregateParity = [2, 3]
    .filter((hash) => snapshot.tooltips[hash])
    .every((hash) => stableStringify(projected[hash]) === stableStringify(snapshot.tooltips[hash]));
  const beforeExport = exportLegacy(
    Object.values(snapshot.tooltips),
    0,
    undefined,
    snapshot.aliases,
  );
  const afterExport = exportLegacy(Object.values(projected), 0, undefined, snapshot.aliases);
  const consumerInputParity = stableStringify(beforeExport) === stableStringify(afterExport);
  const authored = buildGlobalUsageIndex(snapshot.tooltips);
  const impact = calculateGlobalImpact(
    snapshot,
    { ...snapshot, tooltips: projected },
    store.entries.map((entry) => ({
      cause: { globalId: entry.id, beforeRevision: entry.revision, afterRevision: entry.revision },
      kind: entry.kind,
      beforeName: entry.name,
      afterName: entry.name,
    })),
    'live',
  );
  const entries = store.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    languages: Object.keys(entry.definitions),
    authoredTooltips: new Set(
      authored
        .find((v) => v.kind === entry.kind && v.name === entry.name)
        ?.usages.map((v) => v.hash),
    ).size,
    resolverConsumers: impact.rows.filter((row) =>
      row.causes.some((cause) => cause.globalId === entry.id),
    ).length,
  }));
  return {
    version: 1,
    repository: snapshot.repository,
    revision: snapshot.revision,
    proposalOnly: true,
    tooltips: Object.keys(snapshot.tooltips).length,
    definitions: entries.length,
    entries,
    aggregateParity,
    consumerInputParity,
    resolverComplete: impact.complete,
    blockers: impact.blockers,
    resolvedConsumerCells: impact.rows.length,
    renderedParity: impact.rows.every((row) => row.before?.rendered === row.after?.rendered),
    /** Reviewable ID/layout proposal, not an authorized migration receipt. */
    store,
  };
}
