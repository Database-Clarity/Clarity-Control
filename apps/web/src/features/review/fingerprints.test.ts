import { afterEach, expect, it, vi } from 'vitest';
import { publishableHash, type Aliases, type Tooltip } from '@clarity/core';
import { fingerprints, type FingerprintRequest } from './fingerprints';
import { pendingTooltips } from './model';
import type { EditorData } from '../../stores/data';

afterEach(() => vi.unstubAllGlobals());

const tooltip: Tooltip = {
  hash: 1,
  associated: [3, 2],
  text: {
    en: { text: 'English', updatedAt: '2026-06-01T00:00:00Z', updatedBy: 'a' },
    de: {
      text: 'Deutsch',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'b',
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
    },
  },
};

it('keeps the pending set identical to uncached publishable hashes across saved revisions and alias changes', async () => {
  const aliases = { 10: { to: 1, kind: 'frame' as const }, 11: { to: 10, kind: 'frame' as const } };
  const original = structuredClone(tooltip);
  const pushed = { 1: await publishableHash(original, aliases) };
  const revisions: Tooltip[] = [
    original,
    {
      ...original,
      text: { ...original.text, en: { ...original.text.en!, updatedBy: 'metadata-only' } },
    },
    { ...original, associated: [2, 3] },
    { ...original, custom: { name: 'Custom', categoryId: 'perk' } },
    {
      ...original,
      text: {
        ...original.text,
        de: { ...original.text.de!, sourceUpdatedAt: original.text.en!.updatedAt },
      },
    },
    { ...original, text: { ...original.text, en: { ...original.text.en!, text: 'New English' } } },
  ];
  const aliasSnapshots: Aliases[] = [aliases, {}, { 10: { to: 1, kind: 'frame' } }];
  for (const aliasSnapshot of aliasSnapshots) {
    for (const revision of revisions) {
      const state = {
        items: {},
        categories: [],
        aliases: aliasSnapshot,
        bundle: { tooltips: { 1: revision }, pushed },
      } as unknown as EditorData;
      const expected = (await publishableHash(revision, aliasSnapshot)) === pushed[1] ? [] : [1];
      expect((await pendingTooltips(state)).map((entry) => entry.tooltip.hash)).toEqual(expected);
      expect((await pendingTooltips(state)).map((entry) => entry.tooltip.hash)).toEqual(expected);
    }
  }
});

it('runs the real worker protocol with exact core digests and reuses unchanged revisions', async () => {
  const posted: unknown[] = [];
  const workerScope = { onmessage: undefined as unknown, postMessage: vi.fn() };
  vi.stubGlobal('self', workerScope);
  await import('./fingerprints.worker');
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(data: unknown) {
      posted.push(data);
      workerScope.postMessage.mockImplementation((response) =>
        this.onmessage?.({ data: response }),
      );
      void (workerScope.onmessage as (event: { data: unknown }) => Promise<void>)({
        data: structuredClone(data),
      });
    }
  }
  vi.stubGlobal('Worker', TestWorker);
  const original = structuredClone(tooltip);
  const aliases = { 10: { to: 1, kind: 'frame' as const } };
  original.bungieSnapshot = {
    description: 'Metadata that is not published',
    snapshotAt: '2026-01-01T00:00:00Z',
  };
  expect(await fingerprints([original], aliases)).toEqual([
    await publishableHash(original, aliases),
  ]);
  expect(await fingerprints([original], aliases)).toEqual([
    await publishableHash(original, aliases),
  ]);
  expect(posted).toHaveLength(1);
  expect((posted[0] as FingerprintRequest).tooltips[0]).not.toHaveProperty('bungieSnapshot');
  const changed = { ...original, associated: [99] };
  expect(await fingerprints([changed], aliases)).toEqual([await publishableHash(changed, aliases)]);
  expect(await fingerprints([original], {})).toEqual([await publishableHash(original)]);
  expect(posted).toHaveLength(3);
});
