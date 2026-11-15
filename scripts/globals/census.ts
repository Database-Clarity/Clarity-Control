import { buildGlobalUsageIndex } from '../../packages/core/src/globals/index.js';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import { calculateGlobalImpact } from '../../packages/core/src/globals/impact.js';
import type { GlobalImpactSnapshot } from '../../packages/core/src/globals/impactModel.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import { legacyDatabaseSchema } from '../../packages/core/src/legacy.js';
import { migrateLegacy } from '../../packages/core/src/migrateLegacy.js';
import type { GlobalInventorySource } from '../../packages/core/src/globals/projection.js';

export function legacyGlobalsCensus(input: unknown, source: GlobalInventorySource) {
  const database = legacyDatabaseSchema.parse(input);
  return globalsCensus({
    ...source,
    tooltips: Object.fromEntries(migrateLegacy(database).map((v) => [v.hash, v])),
    aliases: {},
    types: Object.fromEntries(Object.values(database.perks).map((v) => [v.hash, v.type])),
    mode: 'live',
  });
}

/** Read-only inventory/parity proposal. No write, migration, or activation option exists. */
export function globalsCensus(snapshot: GlobalImpactSnapshot) {
  let counter = 0;
  const store = inventoryGlobals(
    Object.values(snapshot.tooltips).filter((v) => v.hash === 2 || v.hash === 3),
    snapshot,
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
