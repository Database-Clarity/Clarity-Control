import { z } from 'zod';
import { publishableHash, type Tooltip } from '@clarity/core';
import { Fixture, tooltip } from './fixture.js';

export const pushTime = 1_900_000_000_000;
export const nextPushTime = pushTime + 60_000;

export function livePerks(fixture: Fixture): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(fixture.live.perks);
}

export function danglingReferences(perks: Record<string, unknown>): string[] {
  const reference = z.object({ aliasOf: z.number() });
  const canonical = z.object({ hash: z.number(), editor: z.record(z.string(), z.unknown()) });
  return Object.entries(perks).flatMap(([hash, entry]) => {
    const parsed = reference.safeParse(entry);
    if (!parsed.success) return [];
    const target = canonical.safeParse(perks[parsed.data.aliasOf]);
    return target.success && target.data.hash === parsed.data.aliasOf ? [] : [hash];
  });
}

export async function reviewed(tooltips: readonly Tooltip[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(tooltips.map(async (value) => [value.hash, await publishableHash(value)])),
  );
}

export async function seedPushGroups(fixture: Fixture) {
  const previous: Tooltip = { ...tooltip('previous changed text'), associated: [999] };
  const changed: Tooltip = {
    ...tooltip('reviewed changed text'),
    associated: [456, 789, 999],
    bungieSnapshot: { description: 'saved manifest text', snapshotAt: '2026-10-01T00:00:00Z' },
  };
  const unchanged: Tooltip = {
    ...tooltip('unchanged text'),
    hash: 234,
    legacy: { lastUpload: 42, uploadedBy: 'migrated' },
    bungieSnapshot: { description: 'metadata-only refresh', snapshotAt: '2026-10-02T00:00:00Z' },
  };
  const oldUnchanged: Tooltip = { ...tooltip('unchanged text'), hash: 234 };
  const unrelated: Tooltip = { ...tooltip('untouched'), hash: 999 };
  const markers = await reviewed([previous, oldUnchanged, unrelated]);
  fixture.aliases = {
    345: { to: 123, kind: 'frame' },
    789: { to: 345, kind: 'sandbox' },
    456: { to: 234, kind: 'frame' },
    890: { to: 456, kind: 'sandbox' },
    1001: { to: 999, kind: 'sandbox' },
  };
  fixture.extraItems = Object.fromEntries(
    [234, 345, 456].map((hash) => [
      hash,
      { hash, name: `Member ${hash}`, categoryId: 'perk', itemHash: hash + 2000 },
    ]),
  );
  fixture.moveData({
    'tooltips/123.json': changed,
    'tooltips/234.json': unchanged,
    'live/pushed.json': markers,
    'live/tooltips/123.json': previous,
    'live/tooltips/234.json': oldUnchanged,
    'live/tooltips/999.json': unrelated,
  });
  const oldCopy = (hash: number, text: string) => ({
    hash,
    editor: { en: { main: text, secondary: text } },
    lastUpload: 17,
    uploadedBy: 'previous uploader',
  });
  fixture.live = {
    ...fixture.live,
    rolloutNote: { preserve: true },
    perks: {
      ...livePerks(fixture),
      123: oldCopy(123, previous.text.en!.text),
      234: { ...oldCopy(234, 'unchanged text'), lastUpload: 111, uploadedBy: 'unchanged uploader' },
      345: oldCopy(345, 'old changed frame copy'),
      789: oldCopy(789, 'old changed sandbox copy'),
      456: oldCopy(456, 'old unchanged frame copy'),
      890: oldCopy(890, 'old unchanged sandbox copy'),
      1001: { hash: 1001, aliasOf: 999, aliasKind: 'sandbox' },
    },
  };
  return { changed, unchanged, previous, oldUnchanged, unrelated, markers };
}
