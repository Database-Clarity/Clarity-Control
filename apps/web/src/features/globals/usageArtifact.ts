import { globalIdSchema, langSchema } from '@clarity/core';
import { z } from 'zod';
import { bundleUrl } from '../../services/bundle';
import { fetchOptionalJson } from '../../services/http';
import type { EditorData } from '../../stores/data';
import { globalUsagesFile, globalUsageStampInputs } from './usageStamp';
import type { GlobalUsages } from './usages';

const globalUseSchema = z.object({
  langs: z.array(langSchema),
  direct: z.boolean(),
  via: z.array(z.string()),
});
const usagesSchema = z.object({
  tooltips: z.array(
    globalUseSchema.extend({
      hash: z.uint32(),
      open: z.object({
        variant: z.uint32(),
        lang: langSchema,
        line: z.int().positive().optional(),
      }),
      members: z.int().positive(),
    }),
  ),
  globals: z.array(globalUseSchema.extend({ id: globalIdSchema })),
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const artifactSchema = z.object({
  stamp: z.object({
    version: z.literal(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    itemsHash: digest,
    aliasesHash: digest,
  }),
  usages: z.record(globalIdSchema, usagesSchema),
});

export const globalUsagesUrl = new URL(globalUsagesFile, bundleUrl).href;

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type UsageRows = Record<string, GlobalUsages>;
const requests = new WeakMap<
  NonNullable<EditorData['bundledUsageInputs']>,
  Promise<UsageRows | undefined>
>();

/** Validate the whole artifact against the loaded snapshot, independently after every reload. */
export function loadUsageArtifact(data: EditorData): Promise<UsageRows | undefined> | undefined {
  const inputs = data.bundledUsageInputs;
  const catalog = data.bundle.globals;
  if (
    !catalog ||
    !inputs ||
    inputs.bundle.sourceCommit !== data.bundle.sourceCommit ||
    inputs.bundle.tooltips !== data.bundle.tooltips ||
    inputs.bundle.globals !== catalog ||
    inputs.bundle.aliasGroups !== data.bundle.aliasGroups ||
    inputs.aliases !== data.aliases ||
    inputs.items !== data.items
  )
    return;
  let request = requests.get(inputs);
  if (!request) {
    request = readUsageArtifact(data, catalog).catch(() => undefined);
    requests.set(inputs, request);
  }
  return request;
}

async function readUsageArtifact(
  data: EditorData,
  catalog: NonNullable<EditorData['bundle']['globals']>,
) {
  const artifact = await fetchOptionalJson(globalUsagesUrl, artifactSchema, { cache: 'no-cache' });
  if (!artifact || artifact.stamp.sourceCommit !== data.bundle.sourceCommit) return;
  const live = catalog.entries.filter((entry) => !entry.tombstone);
  if (
    Object.keys(artifact.usages).length !== live.length ||
    live.some(({ id }) => !Object.hasOwn(artifact.usages, id))
  )
    return;
  const { items, aliases } = globalUsageStampInputs(
    data.items,
    data.aliases,
    data.bundle.aliasGroups,
  );
  const [itemsHash, aliasesHash] = await Promise.all([sha256(items), sha256(aliases)]);
  if (artifact.stamp.itemsHash === itemsHash && artifact.stamp.aliasesHash === aliasesHash)
    return artifact.usages;
}
