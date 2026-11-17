import { z } from 'zod';
import { aliasesSchema, type Aliases } from '../aliases.js';
import { type Lang } from '../languages.js';
import type { Tooltip } from '../schemas.js';
import { globalCauseSchema, globalConsumerSchema, globalRevisionSchema } from './model.js';

/** Pin a complete snapshot, including archived records and the effective alias map. */
export interface GlobalImpactSnapshot {
  repository: string;
  revision: string;
  tooltips: Readonly<Record<string, Tooltip>>;
  aliases: Aliases;
  /** Exact converter types, including aliases with their own exported facts. A factless alias
   * inherits its canonical context, just as expandAliases does. Never use a category guess.
   */
  types: Readonly<Record<string, string>>;
  mode: 'authored' | 'live';
}

export const globalReadSchema = z
  .object({
    imports: z.array(z.object({ key: z.string(), hash: z.number().int().nonnegative() }).strict()),
    variables: z.array(z.string()),
    /** All global titles are prepared, even when their display tag is absent. */
    conservativeTitles: z.literal(true),
  })
  .strict();
export const globalImpactRowSchema = z
  .object({
    consumer: globalConsumerSchema,
    causes: z.array(globalCauseSchema).min(1),
    reason: z.enum(['variable-read', 'title-preparation', 'aggregate-import', 'unproven']),
    before: z.object({ rendered: z.string(), reads: globalReadSchema }).strict().nullable(),
    after: z.object({ rendered: z.string(), reads: globalReadSchema }).strict().nullable(),
  })
  .strict();
export const globalImpactSchema = z
  .object({
    version: z.literal(1),
    beforeRevision: globalRevisionSchema,
    afterRevision: globalRevisionSchema,
    complete: z.boolean(),
    blockers: z.array(z.string()),
    rows: z.array(globalImpactRowSchema),
  })
  .strict()
  .refine((v) => v.complete === (v.blockers.length === 0), 'Completeness requires no blockers');

export type GlobalRead = z.infer<typeof globalReadSchema>;
export type GlobalImpactRow = z.infer<typeof globalImpactRowSchema>;
export type GlobalImpact = z.infer<typeof globalImpactSchema>;
export interface GlobalImpactChange {
  cause: z.infer<typeof globalCauseSchema>;
  kind: 'variables' | 'titles';
  beforeName?: string;
  afterName?: string;
  /** Omit for all languages. Both snapshots still decide fallback dependencies. */
  languages?: readonly Lang[];
}

/** Validation of the portable snapshot header; text remains Tooltip-schema validated. */
export const globalImpactHeaderSchema = z
  .object({
    repository: z.string().min(1),
    revision: globalRevisionSchema,
    aliases: aliasesSchema,
    types: z.record(z.string(), z.string()),
    mode: z.enum(['authored', 'live']),
  })
  .strict();
