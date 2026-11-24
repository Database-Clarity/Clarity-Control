import { z } from 'zod';
import { langSchema } from '../languages.js';
import { hashSchema } from '../legacy.js';
import { globalDigestSchema, globalIdSchema, globalKindSchema } from './model.js';

const oid = z.string().regex(/^[0-9a-f]{40}$/);

/** Absent before migration. Both states prohibit the old publication path. */
export const globalsInPlacePath = 'config/globals-in-place.json';
export const globalsInPlaceCapability = 'globalsInPlaceV1';
export const globalsInPlaceFenceSchema = z
  .object({
    state: z.enum(['hold', 'active']),
    destination: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    legacyData: oid,
    legacyLive: oid,
    migratedLive: oid,
  })
  .strict();
export type GlobalsInPlaceFence = z.infer<typeof globalsInPlaceFenceSchema>;

/** Presence of this array, even empty, identifies the switched Review model. */
export const globalsPendingSchema = z.array(
  z.object({
    id: globalIdSchema,
    name: z.string(),
    kind: globalKindSchema,
    change: z.enum(['new', 'changed', 'renamed', 'removed']),
    digest: globalDigestSchema,
    languages: z.partialRecord(
      langSchema,
      z.object({
        before: z.string().nullable(),
        after: z.string().nullable(),
        beforeAvailable: z.boolean().optional(),
        afterAvailable: z.boolean().optional(),
      }),
    ),
    affected: z.array(hashSchema),
    refusal: z.string().optional(),
  }),
);
export type GlobalsPending = z.infer<typeof globalsPendingSchema>;

export const globalPublishSelectionSchema = z
  .object({
    id: globalIdSchema,
    expected: globalDigestSchema,
  })
  .strict();
