import { z } from 'zod';
import { langSchema } from './languages.js';
import { legacyStatsSchema } from './legacyStats.js';
import { weaponTypeLabelsSchema } from './markup/specialize.js';

export const hashSchema = z.number().int().min(0).max(0xffffffff);
export const trackerEntrySchema = z.object({
  lastUpdate: z.number().int().nonnegative(),
  updatedBy: z.string().optional(),
}).strict();
export const legacyMetadataSchema = z.object({
  uploadedBy: z.string().optional(),
  lastUpload: z.number().int().nonnegative().optional(),
  inLiveDatabase: z.boolean().optional(),
  uploadToLive: z.boolean().optional(),
  updateTracker: z.object({
    descriptions: z.partialRecord(langSchema, trackerEntrySchema),
  }).strict().optional(),
}).strict();
export const legacyPerkSchema = legacyMetadataSchema.extend({
  hash: hashSchema,
  name: z.string(),
  type: z.string(),
  itemHash: hashSchema.optional(),
  itemName: z.string().optional(),
  editor: z.partialRecord(langSchema, z.object({
    main: z.string(), secondary: z.string(),
  }).strict()),
  updateTracker: z.object({
    descriptions: z.partialRecord(langSchema, trackerEntrySchema),
    stats: trackerEntrySchema.optional(),
  }).strict().optional(),
  stats: legacyStatsSchema.optional(),
  importStatsFrom: hashSchema.optional(),
  duration: z.array(z.number().finite()).optional(),
  activationCondition: z.string().optional(),
}).strict();
export const legacyDatabaseSchema = z.object({
  perks: z.record(z.string().regex(/^(0|[1-9]\d*)$/), legacyPerkSchema),
  databaseSettings: z.object({
    folders: z.record(z.string(), z.array(z.object({
      name: z.string(), has: z.array(hashSchema), hash: hashSchema.optional(),
    }).strict())),
    enhancedPerks: z.record(z.string(), z.object({
      name: z.string(), linkedWith: hashSchema,
    }).strict()),
    weaponTypeLabels: weaponTypeLabelsSchema.optional(),
  }).strict(),
}).strict().superRefine(({ perks }, context) => {
  for (const [hash, perk] of Object.entries(perks)) {
    if (Number(hash) !== perk.hash) {
      context.addIssue({ code: 'custom', path: ['perks', hash, 'hash'], message: 'Hash must match record key' });
    }
  }
});
export type LegacyPerk = z.infer<typeof legacyPerkSchema>;
export type LegacyDatabase = z.infer<typeof legacyDatabaseSchema>;
export type LegacyMetadata = z.infer<typeof legacyMetadataSchema>;
/** `weaponTypes` is intermediate-only: the converter consumes it, published output never carries it. */
export type LegacyFacts = Pick<LegacyPerk, 'name' | 'type' | 'itemHash' | 'itemName'> & {
  weaponTypes?: string[];
};
export type LegacyCatalog = Record<string, LegacyFacts>;
