import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { bundleSchema } from '../../services/bundleSchema';
import type { EditorData } from '../../stores/data';
import { globalUsagesUrl, loadUsageArtifact } from './usageArtifact';
import { globalUsageStampInputs } from './usageStamp';

const id = 'g_damages01';
const bundle = bundleSchema.parse({
  sourceCommit: 'a'.repeat(40),
  generatedAt: '2026-11-21T00:00:00Z',
  tooltips: {},
  permissions: { users: {} },
  pushed: {},
  globals: {
    entries: [
      {
        version: 1,
        id,
        kind: 'variables',
        name: 'Damage',
        revision: 'r1',
        nameHistory: [],
        definitions: {
          en: { body: '10%', revision: 'r1', updatedAt: '2026-11-21T00:00:00Z', updatedBy: 'a' },
        },
      },
    ],
    sync: { status: 'current', causeIds: [], lastFailure: null, causeEntries: {} },
  },
});
const item = {
  hash: 10,
  baseHash: 20,
  name: 'Pair',
  categoryId: 'weapon-mod',
  icon: '',
  inGameDescription: '',
};
const data: EditorData = {
  bundle,
  items: { 10: item },
  categories: [],
  aliases: { 123: { to: 10, kind: 'sandbox' } },
};
function loaded(value: EditorData): EditorData {
  return {
    ...value,
    bundledUsageInputs: { bundle: value.bundle, items: value.items, aliases: value.aliases },
  };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const inputs = globalUsageStampInputs(data.items, data.aliases, data.bundle.aliasGroups);
const artifact = {
  stamp: {
    version: 1,
    sourceCommit: bundle.sourceCommit,
    itemsHash: digest(inputs.items),
    aliasesHash: digest(inputs.aliases),
  },
  usages: { [id]: { tooltips: [], globals: [] } },
};
afterEach(() => vi.unstubAllGlobals());

it('accepts computed zero, shares a request, and validates the refreshed inputs again', async () => {
  const fetchArtifact = vi.fn(async () => Response.json(artifact));
  vi.stubGlobal('fetch', fetchArtifact);
  const first = loaded(data);
  const request = loadUsageArtifact(first);
  expect(loadUsageArtifact({ ...first })).toBe(request);
  await expect(request).resolves.toEqual(artifact.usages);

  // D and E: fresh inputs independently disagree with the publisher's pinned inputs.
  await expect(
    loadUsageArtifact(loaded({ ...data, items: { 10: { ...item, baseHash: 30 } } })),
  ).resolves.toBeUndefined();
  await expect(
    loadUsageArtifact(loaded({ ...data, aliases: { 123: { to: 20, kind: 'sandbox' } } })),
  ).resolves.toBeUndefined();
  await expect(loadUsageArtifact(loaded({ ...data, items: {} }))).resolves.toBeUndefined();
  await expect(
    loadUsageArtifact(
      loaded({
        ...data,
        bundle: { ...bundle, aliasGroups: { version: 1, groups: {}, rejected: {} } },
      }),
    ),
  ).resolves.toBeUndefined();
  expect(fetchArtifact).toHaveBeenCalledTimes(5);
  expect(fetchArtifact).toHaveBeenCalledWith(globalUsagesUrl, { cache: 'no-cache' });
});

it.each([
  { ...artifact, stamp: { ...artifact.stamp, sourceCommit: 'b'.repeat(40) } },
  { ...artifact, stamp: { ...artifact.stamp, itemsHash: 'malformed' } },
  { usages: artifact.usages },
  { ...artifact, usages: {} },
  { ...artifact, usages: { [id]: { tooltips: null, globals: [] } } },
  undefined,
])(
  'discards the entire usage artifact when missing, stale, incomplete, or invalid (%#)',
  async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (payload ? Response.json(payload) : new Response('', { status: 404 }))),
    );
    await expect(loadUsageArtifact(loaded(data))).resolves.toBeUndefined();
  },
);
