import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  inventoryGlobals,
  projectGlobals,
  type GlobalInventorySource,
} from '../../packages/core/src/globals/projection.js';
import { globalStoreSchema, type GlobalStore } from '../../packages/core/src/globals/model.js';
import {
  globalLayoutSchema,
  globalPublishedSchema,
} from '../../packages/core/src/globalsRelease/model.js';
import { changedGlobalIds } from '../../packages/core/src/globalsRelease/compose.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import type { Tooltip } from '../../packages/core/src/schemas.js';
import {
  catalogSchema,
  entrySchema,
  globalFileBytes,
  limits,
  pageSchema,
  syncSchema,
} from '../../apps/worker/src/globals/model.js';

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const identityKey = (kind: string, name: string) => `${kind}:${name}`;
export interface Inventory {
  documents: Record<string, Tooltip>;
  source: GlobalInventorySource;
}

/** The manifest retains the generated opaque IDs; apply never allocates new identities. */
export function bootstrapFiles(
  saved: Inventory,
  live: Inventory,
  destination: string,
  ids: Record<string, string> = {},
  existing?: { saved: GlobalStore; published: GlobalStore },
) {
  const allocated = { ...ids };
  const inventory = ({ documents, source }: Inventory, prior?: GlobalStore): GlobalStore => {
    if (!documents[2] || !documents[3]) throw new Error('Both libraries 2 and 3 are required');
    if (prior) {
      globalStoreSchema.parse(prior);
      if (prior.aggregates.length !== 2 || prior.entries.some((entry) => entry.kind === 'exports'))
        throw new Error('Expected installed variables/titles; exports must not already exist');
      const projected = projectGlobals(prior);
      for (const hash of [2, 3])
        if (stableStringify(projected[hash]) !== stableStringify(documents[hash]))
          throw new Error('Existing global identity/projection would change');
      if (!documents[1]) throw new Error('Export library 1 is required');
    }
    const store = inventoryGlobals(
      prior ? [documents[1]] : [documents[2], documents[3]],
      source,
      () => `g_${randomUUID()}`,
    );
    const remap = new Map<string, string>();
    for (const entry of store.entries) {
      const key = identityKey(entry.kind, entry.name);
      allocated[key] ??= `g_${randomUUID()}`;
      remap.set(entry.id, allocated[key]);
      entry.id = allocated[key];
      entrySchema.parse(entry);
      if (globalFileBytes(entry) > limits.entryBytes)
        throw new Error(`Entry exceeds byte cap: ${key}`);
    }
    for (const aggregate of store.aggregates)
      for (const layout of Object.values(aggregate.languages))
        for (const segment of layout.segments)
          if ('entryId' in segment) segment.entryId = remap.get(segment.entryId)!;
    if (prior) {
      store.entries.unshift(...structuredClone(prior.entries));
      store.aggregates.unshift(...structuredClone(prior.aggregates));
    }
    globalStoreSchema.parse(store);
    const projected = projectGlobals(store);
    for (const hash of prior ? [1, 2, 3] : [2, 3])
      if (stableStringify(projected[hash]) !== stableStringify(documents[hash]))
        throw new Error(`Aggregate round-trip differs: ${source.revision}/${hash}`);
    return store;
  };
  const savedStore = inventory(saved, existing?.saved),
    liveStore = inventory(live, existing?.published);
  const inventories = { saved: structuredClone(savedStore), published: structuredClone(liveStore) };
  const equalityBody = (entry: GlobalStore['entries'][number]) =>
    Object.fromEntries(
      Object.entries(entry.definitions).map(([lang, definition]) => {
        const { revision: _revision, provenance: _provenance, ...original } = definition;
        void _revision;
        void _provenance;
        return [lang, original];
      }),
    );
  // Root-approved bootstrap rule: equal independent inventories share verified identity and
  // ancestry, rather than manufacture a saved edit solely from migration metadata.
  const identityEvidence = liveStore.entries.map((entry, i) => {
    const current = savedStore.entries.find((saved) => saved.id === entry.id);
    const shared =
      current !== undefined &&
      stableStringify(equalityBody(current)) === stableStringify(equalityBody(entry));
    if (shared && (!existing || entry.kind === 'exports'))
      liveStore.entries[i] = structuredClone(current);
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      shared,
      savedSource: current ? saved.source : null,
      publishedSource: live.source,
      savedDefinitions: current ? equalityBody(current) : null,
      publishedDefinitions: equalityBody(entry),
    };
  });
  for (const entry of savedStore.entries.filter(
    (entry) => !liveStore.entries.some((live) => live.id === entry.id),
  ))
    identityEvidence.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      shared: false,
      savedSource: saved.source,
      publishedSource: live.source,
      savedDefinitions: equalityBody(entry),
      publishedDefinitions: {},
    });
  // Live-only identities need an explicit reviewed tombstone decision; never invent a deletion.
  const reviewDifferences = changedGlobalIds(liveStore, savedStore);
  const files: Record<string, string> = {};
  const add = (path: string, value: unknown, maximum?: number) => {
    if (maximum !== undefined && globalFileBytes(value) > maximum)
      throw new Error(`Metadata exceeds byte cap: ${path}`);
    files[path] = json(value);
  };
  add(
    'globals/layout.json',
    globalLayoutSchema.parse({ version: 1, aggregates: savedStore.aggregates }),
  );
  add(
    `globals/live/${destination}.json`,
    globalPublishedSchema.parse({ version: 1, destination, store: liveStore }),
  );
  add(
    'globals/sync.json',
    syncSchema.parse({
      version: 1,
      status: 'current',
      causeIds: [],
      causeEntries: {},
      lastFailure: null,
    }),
    limits.metadataBytes,
  );
  const claimSchema = z
    .object({
      id: entrySchema.shape.id,
      kind: entrySchema.shape.kind,
      name: z.string().min(1).max(128),
    })
    .strict();
  for (const entry of savedStore.entries) {
    if (existing && entry.kind !== 'exports') continue;
    add(`globals/entries/${entry.id}.json`, entrySchema.parse(entry), limits.entryBytes);
    const key = sha256(`${entry.kind}:${entry.name}`);
    add(
      `globals/names/${entry.kind}/${key}.json`,
      claimSchema.parse({ id: entry.id, kind: entry.kind, name: entry.name }),
      limits.metadataBytes,
    );
  }
  const entries = savedStore.entries.map((entry) => entry.id);
  const count = Math.max(1, Math.ceil(entries.length / limits.page));
  add(
    'globals/catalog.json',
    catalogSchema.parse({ version: 1, lastPage: count - 1 }),
    limits.metadataBytes,
  );
  for (let i = 0; i < count; i++)
    add(
      `globals/pages/p${i}.json`,
      pageSchema.parse({
        version: 1,
        ids: entries.slice(i * limits.page, (i + 1) * limits.page),
        nextCursor: i + 1 < count ? `p${i + 1}` : null,
      }),
      limits.metadataBytes,
    );
  if (existing) {
    delete files['globals/sync.json'];
    for (const [prior, next] of [
      [existing.saved, savedStore],
      [existing.published, liveStore],
    ])
      for (const entry of prior.entries)
        if (
          stableStringify(next.entries.find((candidate) => candidate.id === entry.id)) !==
          stableStringify(entry)
        )
          throw new Error('Existing global identity would change');
  }
  return {
    files,
    ids: allocated,
    savedStore,
    liveStore,
    inventories,
    identityEvidence,
    reviewDifferences,
  };
}
