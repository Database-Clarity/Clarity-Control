import { z } from 'zod';
import facts from './manifest-facts.json';

const hash = z.number().int().nonnegative();
const nullableHash = hash.nullable();
const rawObject = z.record(z.string(), z.unknown());
const component = z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const inventory = z.object({
  displayName: z.string().nullable(), description: z.string().nullable(),
  itemCategoryHashes: z.array(hash).nullable(), itemType: nullableHash,
  plug: z.object({ plugCategoryIdentifier: z.string().nullable(), plugCategoryHash: nullableHash }).nullable(),
  investmentStats: z.array(z.object({ statTypeHash: hash, value: z.number(), isConditionallyActive: z.boolean() }).passthrough()).nullable(),
  perks: z.array(rawObject).nullable(), redacted: z.boolean().nullable(), ammoType: nullableHash,
  powerCapHashes: z.array(nullableHash).nullable(), tooltipNotifications: z.array(rawObject).nullable(),
});
const usage = z.object({ ownerHash: hash, ownerItemType: nullableHash, socketIndex: hash, socketCategoryHash: nullableHash, ordinal: nullableHash, source: z.enum(['singleInitialItemHash', 'reusablePlugItems', 'randomizedPlugSetHash', 'reusablePlugSetHash']), plugSetHash: nullableHash });
const membership = z.union([
  z.object({ source: z.literal('artifact'), artifactHash: hash, artifactName: z.string().nullable().optional(), tierIndex: hash, itemIndex: hash, item: rawObject }),
  z.object({ source: z.literal('inventoryPreview'), ownerHash: hash, artifactHash: hash, artifactName: z.string().nullable().optional(), categoryIndex: hash, itemIndex: hash, item: rawObject }),
]);
export const manifestFactsSchema = z.object({
  source: z.object({ manifestVersion: z.string(), manifestUrl: z.string().url(), manifestSha256: component.shape.sha256, generatorUrl: z.string().url(), generatorSha256: component.shape.sha256, components: z.object({ DestinyInventoryItemDefinition: component, DestinyPlugSetDefinition: component, DestinyArtifactDefinition: component }) }),
  items: z.record(z.string().regex(/^\d+$/), z.object({ inventory: inventory.nullable(), plugUsages: z.array(z.object({ ownerItemType: nullableHash, socketCategoryHash: nullableHash, ordinal: nullableHash, count: z.number().int().positive(), exemplar: usage })), artifactMemberships: z.array(membership), retired: z.null(), sunset: z.null(), currentArtifact: z.null() })),
});
export type ManifestFacts = z.infer<typeof manifestFactsSchema>;
export function loadManifestFacts(input: unknown = facts): ManifestFacts { return manifestFactsSchema.parse(input); }
