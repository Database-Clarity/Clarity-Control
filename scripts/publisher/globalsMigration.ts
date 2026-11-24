import { isDeepStrictEqual } from 'node:util';
import {
  exportLegacy,
  currentSavePath,
  currentSaveStageRecord,
  globalsInPlaceCapability,
  globalsInPlaceDefinition,
  globalsInPlaceDefinitions,
  globalsInPlaceFenceSchema,
  globalsInPlacePath,
  inPlaceReferenceIssue,
  languages,
  legacyGlobalsInPlaceDefinitions,
  projectGlobals,
  type GlobalsInPlaceFence,
} from '../../packages/core/src/index.js';
import { batchSchema, scheduleRequestSchema } from '@clarity/core/schedule';
import {
  buildLegacy,
  bungieIdentical,
  compile,
  exportLanguages,
  legacyPresets,
  newStyleFile,
  type Catalog,
  type InventoryItems,
  type LegacyInput,
  type SandboxPerks,
} from '../../packages/export/src/index.js';
import { appCredits, LocalRepository } from './git.js';
import { GlobalsPublisher } from './globals.js';
import {
  publishedGlobals,
  assertLinkVariableValues,
  globalsFence,
  historicalSecondaryUses,
  liveGlobalsInput,
  migrateInPlace,
  sharedVariableLabelIssue,
} from './globalsInPlace.js';
import type { Publisher } from './publisher.js';

export interface MigrationInputs {
  catalog: Catalog;
  inventoryItems: InventoryItems;
  sandboxPerks: SandboxPerks;
}

export function proveMigrationFiles(
  before: LegacyInput,
  after: LegacyInput,
  inputs: MigrationInputs,
) {
  const { catalog, inventoryItems, sandboxPerks } = inputs;
  if (
    !Object.keys(inventoryItems).length ||
    !Object.keys(catalog.items).length ||
    !catalog.categories.length
  )
    throw new Error('Migration requires the pinned manifest and format-v2 catalog.');
  const identical = bungieIdentical(before, inventoryItems, sandboxPerks);
  if (
    JSON.stringify(identical) !==
    JSON.stringify(bungieIdentical(after, inventoryItems, sandboxPerks))
  )
    throw new Error('Migration changes Bungie-identical selection.');
  const files: string[] = [];
  const compare = (name: string, old: Uint8Array, next: Uint8Array) => {
    if (!Buffer.from(old).equals(next)) throw new Error(`Migration changes ${name}.`);
    files.push(name);
  };
  for (const preset of legacyPresets)
    compare(
      preset,
      buildLegacy(before, preset, { identical }),
      buildLegacy(after, preset, { identical }),
    );
  for (const style of ['structured', 'markdown'] as const)
    for (const lang of exportLanguages) {
      const file = newStyleFile('migration', style, {
        categories: catalog.categories.map(({ id }) => id),
        sandboxPerks: [],
        frameAliases: true,
        languages: [lang],
        keys: ['name'],
        languageFiles: 'combined',
        bungieIdentical: false,
      });
      const options = { catalog, identical };
      compare(
        `${style}/${lang}`,
        compile(before, file, options).bytes,
        compile(after, file, options).bytes,
      );
    }
  return files;
}

function assertDisposable(pub: Publisher): LocalRepository {
  if (pub.git.constructor !== LocalRepository)
    throw new Error('Migration is available only in a disposable local clone.');
  return pub.git as LocalRepository;
}

function assertDrained(pub: Publisher, git: LocalRepository, data: string) {
  const tree = git.tree(data);
  for (const path of Object.keys(tree)) {
    if (path.startsWith('publish/requests/') || path.startsWith('globals/intents/'))
      throw new Error(`Drain ${path} with the old publisher first.`);
    if (path.startsWith(currentSavePath) && path.endsWith('/request.json')) {
      const save = currentSaveStageRecord.parse(pub.read(tree, path));
      if (save.status === 'uploading' || save.status === 'queued')
        throw new Error(`Finish or cancel ${path} with the old publisher first.`);
    }
    if (/^schedule\/requests\/[^/.]+\.json$/.test(path)) {
      const request = scheduleRequestSchema.parse(pub.read(tree, path));
      if (request.status === 'pending' || request.status === 'needs_attention')
        throw new Error(`Finish or cancel ${path} with the old publisher first.`);
    }
    if (/^schedule\/batches\/[^/]+\/batch\.json$/.test(path)) {
      const batch = batchSchema.parse(pub.read(tree, path));
      if (
        ['preparing', 'scheduled', 'publishing'].includes(batch.status) ||
        (batch.status === 'needs_attention' && batch.preparation?.returnStatus === 'scheduled')
      )
        throw new Error(`Finish or unschedule batch ${batch.id} with the old publisher first.`);
    }
  }
  if (git.git(['for-each-ref', '--format=%(refname)', 'refs/heads/publish-candidate/']).trim())
    throw new Error('Recover old publisher candidates before migration.');
  const live = git.tree(pub.head(pub.options.liveBranch));
  for (const path of Object.keys(live).filter((file) => file.startsWith('.publish/receipts/'))) {
    const log = pub.read<{ result?: { status?: string } }>(
      tree,
      path.replace('.publish/receipts/', 'publish/log/'),
    );
    if (log?.result?.status !== 'done' && log?.result?.status !== 'unchanged')
      throw new Error(`Recover the RECORD for ${path} with the old publisher first.`);
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/**
 * The hold is also the recovery journal. While it exists, a retry accepts only the
 * exact planned LIVE ref. The companion RECORD preserves every authored marker.
 */
export async function dryRunGlobalsMigration(
  pub: Publisher,
  inputs: MigrationInputs,
  checkpoint?: (step: 'hold' | 'live' | 'record') => void,
) {
  const git = assertDisposable(pub);
  const dataRef = `refs/heads/${pub.options.dataBranch}`;
  const liveRef = `refs/heads/${pub.options.liveBranch}`;
  const source = pub.head(pub.options.dataBranch);
  const tree = git.tree(source);
  const installed = pub.read<{ capabilities: string[] }>(tree, '.publisher/PIN');
  if (!installed?.capabilities.includes(globalsInPlaceCapability))
    throw new Error('Install the in-place publisher PIN before migration.');

  let journal = globalsFence(pub, tree);
  let hold = source;
  const legacyLive = journal?.legacyLive ?? pub.head(pub.options.liveBranch);
  const legacyData = journal?.legacyData ?? source;
  const legacyTree = git.tree(legacyData);
  if (
    journal &&
    (Object.keys(tree).length !== Object.keys(legacyTree).length + 1 ||
      Object.keys(legacyTree).some((path) => tree[path] !== legacyTree[path]))
  )
    throw new Error(
      'Editor Data moved during the shared text migration. Preserve those saves and plan again.',
    );
  const { saved, published, authored, live } = new GlobalsPublisher(pub).capture(
    legacyTree,
    legacyData,
    legacyLive,
  );
  const before = liveGlobalsInput(pub, legacyLive);
  const entries = [...published.entries, ...saved.entries].filter(({ tombstone }) => !tombstone);
  const names = new Set(entries.filter(({ kind }) => kind === 'variables').map(({ name }) => name));
  const titles = new Set(entries.filter(({ kind }) => kind === 'titles').map(({ name }) => name));
  const definitionStores = [saved, published].map(
    (store) => globalsInPlaceDefinitions(store.entries).variables,
  );
  const checkLabel = (text: string, context: string) => {
    const issue =
      sharedVariableLabelIssue(text, names) ?? inPlaceReferenceIssue(text, names, titles);
    if (issue) throw new Error(`${context}: ${issue}`);
    for (const variables of definitionStores)
      assertLinkVariableValues(text, context, variables, names);
  };
  for (const entry of entries)
    for (const [lang, cell] of Object.entries(entry.definitions))
      checkLabel(cell.body, `${entry.name} (${lang})`);
  for (const snapshot of [authored, live])
    for (const tooltip of Object.values(snapshot.tooltips))
      for (const [lang, cell] of Object.entries(tooltip.text))
        checkLabel(cell.text, `Tooltip ${tooltip.hash} (${lang})`);
  for (const row of Object.values(before.perks)) {
    if (!('editor' in row)) continue;
    for (const [lang, cell] of Object.entries(row.editor))
      for (const text of [cell.main, cell.secondary])
        checkLabel(text, `LIVE tooltip ${row.hash} (${lang})`);
  }
  for (const hash of [1, 2, 3]) {
    const library = before.perks[hash];
    if (!library || !('editor' in library)) continue;
    for (const [lang, cell] of Object.entries(library.editor))
      if (cell.englishFallback)
        throw new Error(`Legacy LIVE library ${hash} (${lang}) falls back to English.`);
  }
  const definitions = (perks: LegacyInput['perks'] | ReturnType<typeof exportLegacy>) =>
    legacyGlobalsInPlaceDefinitions(perks as Parameters<typeof legacyGlobalsInPlaceDefinitions>[0]);
  const liveDefinitions = definitions(before.perks);
  const projected = exportLegacy(Object.values(projectGlobals(published)), 0, pub.options.facts);
  if (!isDeepStrictEqual(liveDefinitions, definitions(projected)))
    throw new Error('Published definitions differ from the effective LIVE libraries.');
  for (const entry of published.entries.filter(({ tombstone }) => !tombstone))
    for (const lang of languages) {
      const liveDefinition = liveDefinitions[entry.kind]?.[entry.name]?.[lang];
      if (Boolean(liveDefinition) !== Boolean(globalsInPlaceDefinition(entry.definitions, lang)))
        throw new Error(`Published availability for ${entry.name} (${lang}) differs from LIVE.`);
    }
  const next = migrateInPlace(before);
  const files = proveMigrationFiles(before, next, inputs);
  const olderSecondaries = historicalSecondaryUses(before, liveDefinitions);
  if (!journal) {
    assertDrained(pub, git, source);
    const migratedLive = git.commit(
      legacyLive,
      {
        ...git.tree(legacyLive),
        'liveDescriptions.json': git.writeBlob(json(next)),
      },
      'Inline shared text in existing LIVE tooltips',
      appCredits,
    );
    journal = globalsInPlaceFenceSchema.parse({
      state: 'hold',
      destination: pub.options.liveBranch,
      legacyData: source,
      legacyLive,
      migratedLive,
    });
    hold = git.commit(
      source,
      {
        ...tree,
        [globalsInPlacePath]: git.writeBlob(json(journal)),
      },
      'Hold publication for shared text migration',
      appCredits,
    );
    git.cas(dataRef, source, hold);
    checkpoint?.('hold');
  }
  const { migratedLive } = journal;
  const originalTree = git.tree(legacyLive);
  const migratedTree = git.tree(migratedLive);
  if (
    git.blob(migratedTree['liveDescriptions.json']) !== json(next) ||
    !git.ancestor(legacyLive, migratedLive) ||
    Object.keys(originalTree).length !== Object.keys(migratedTree).length ||
    Object.keys(originalTree).some(
      (path) => path !== 'liveDescriptions.json' && originalTree[path] !== migratedTree[path],
    ) ||
    !git.ancestor(journal.legacyData, hold)
  )
    throw new Error('Migration journal differs from its proven inputs.');
  const currentLive = pub.head(pub.options.liveBranch);
  if (pub.head(pub.options.dataBranch) !== hold)
    throw new Error(
      'Editor Data moved during the shared text migration. Preserve those saves and plan again.',
    );
  if (currentLive === legacyLive && journal.state === 'hold') {
    git.cas(liveRef, legacyLive, migratedLive);
    checkpoint?.('live');
  } else if (currentLive !== migratedLive) {
    throw new Error('LIVE moved during the shared text migration.');
  }
  const fence: GlobalsInPlaceFence = { ...journal, state: 'active' };
  const recordTree = { ...git.tree(hold), [globalsInPlacePath]: git.writeBlob(json(fence)) };
  const record =
    journal.state === 'active'
      ? hold
      : git.commit(hold, recordTree, 'Record shared text migration and enable Review', appCredits);
  publishedGlobals(pub, recordTree);
  if (journal.state === 'hold') {
    git.cas(dataRef, hold, record);
    checkpoint?.('record');
  }
  return { record, live: migratedLive, files, olderSecondaries };
}

/** Restore only the exact migration snapshots in the disposable clone. */
export function restoreGlobalsMigration(pub: Publisher) {
  const git = assertDisposable(pub);
  const data = pub.head(pub.options.dataBranch);
  const live = pub.head(pub.options.liveBranch);
  const tree = git.tree(data);
  const fence = globalsFence(pub, tree);
  if (!fence) return;
  const { legacyData, legacyLive, migratedLive } = fence;
  const before = git.tree(legacyData);
  if (
    !git.ancestor(legacyData, data) ||
    (live !== legacyLive && live !== migratedLive) ||
    Object.keys(before).length + 1 !== Object.keys(tree).length ||
    Object.keys(before).some((path) => tree[path] !== before[path])
  )
    throw new Error('Publication or a save advanced after migration; restore is unavailable.');
  const update = { ref: `refs/heads/${pub.options.dataBranch}`, old: data, next: legacyData };
  if (live === migratedLive)
    git.casMany([
      update,
      { ref: `refs/heads/${pub.options.liveBranch}`, old: live, next: legacyLive },
    ]);
  else git.cas(update.ref, update.old, update.next);
}
