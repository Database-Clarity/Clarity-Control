import { z } from 'zod';
import { globalStoreSchema } from '../globals/model.js';

/** Bump this contract before changing an identity input or its interpretation. */
export const globalsReleaseVersion = 1;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const globalSourcesSchema = z
  .object({
    authored: oid,
    definitions: oid,
    projections: oid,
    config: oid,
    live: oid,
    upcoming: oid,
    aliases: oid,
    generator: oid,
    fallback: digest,
    resolver: digest,
  })
  .strict();
export type GlobalSources = z.infer<typeof globalSourcesSchema>;
export const globalLayoutSchema = z
  .object({ version: z.literal(1), aggregates: globalStoreSchema.shape.aggregates })
  .strict()
  .refine(
    (layout) =>
      (layout.aggregates.length === 2 || layout.aggregates.length === 3) &&
      new Set(layout.aggregates.map((aggregate) => aggregate.document.hash)).size ===
        layout.aggregates.length &&
      layout.aggregates.every((aggregate) => [1, 2, 3].includes(aggregate.document.hash)) &&
      [2, 3].every((hash) =>
        layout.aggregates.some((aggregate) => aggregate.document.hash === hash),
      ),
    'Both compatibility libraries are required',
  );
export const globalPublishedSchema = z
  .object({
    version: z.literal(1),
    destination: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    store: globalStoreSchema,
  })
  .strict()
  .refine(
    (published) =>
      (published.store.aggregates.length === 2 || published.store.aggregates.length === 3) &&
      [2, 3].every((hash) =>
        published.store.aggregates.some((aggregate) => aggregate.document.hash === hash),
      ),
    'Both published compatibility libraries are required',
  );
export const globalsReleasePaths = {
  layout: 'globals/layout.json',
  sync: 'globals/sync.json',
  entry: (id: string) => `globals/entries/${id}.json`,
  published: (destination: string) => `globals/live/${destination}.json`,
};

/** Git identities to observe independently at the current authenticated head.
 * Missing trees use Git's empty-tree OID; a missing required layout never does.
 */
export const globalSourcePaths = {
  authored: 'tooltips',
  definitions: 'globals/entries',
  projections: 'globals/projections',
  config: 'config',
  upcoming: 'schedule',
  aliasGroups: 'config/alias-groups.json',
  sandboxPointers: 'config/sandbox-pointers.json',
} as const;
export const emptyGitTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function globalIdentityDigest(
  value: unknown,
  algorithm: 'SHA-1' | 'SHA-256' = 'SHA-256',
) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** No corpus reads: the adapter supplies actual tree/blob/ref OIDs, never a stored manifest.
 * Publisher and S5 must use the same installed runtime PIN as resolverRevision. This
 * deliberately invalidates certificates on a runtime upgrade, including fallback changes.
 */
export async function observeGlobalSources(input: {
  authored: string;
  definitions: string;
  projections: string;
  layout: string;
  published: string;
  config: string;
  live: string;
  upcoming: string;
  aliasGroups: string | null;
  sandboxPointers: string | null;
  generator: string;
  resolverRevision: string;
}): Promise<GlobalSources> {
  for (const value of Object.values(input)) if (value !== null) oid.parse(value);
  return globalSourcesSchema.parse({
    authored: input.authored,
    definitions: input.definitions,
    projections: await globalIdentityDigest(
      [1, input.projections, input.layout, input.published],
      'SHA-1',
    ),
    config: input.config,
    live: input.live,
    upcoming: input.upcoming,
    aliases: await globalIdentityDigest(
      [1, input.aliasGroups, input.sandboxPointers, input.generator],
      'SHA-1',
    ),
    generator: input.generator,
    fallback: await globalIdentityDigest([
      1,
      'exportLegacy/globalSourceText',
      input.resolverRevision,
    ]),
    resolver: await globalIdentityDigest([1, 'calculateGlobalImpact', input.resolverRevision]),
  });
}
