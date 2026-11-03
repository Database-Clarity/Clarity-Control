import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import {
  danglingReferences,
  livePerks,
  nextPushTime,
  pushTime,
  reviewed,
  seedPushGroups,
} from './push-fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: pushTime });
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sequential push-live batches', () => {
  it.each([true, false])(
    'converts complete alias groups in either rollout order (changed first: %s)',
    async (changedFirst) => {
      const values = await seedPushGroups(fixture);
      const initialLive = structuredClone(fixture.live);
      const initialPerks = livePerks(fixture);
      const groups = [
        { value: values.changed, hashes: [123, 345, 789], aliases: [345, 789] },
        { value: values.unchanged, hashes: [890], aliases: [456, 890] },
      ];
      if (!changedFirst) groups.reverse();
      const [first, second] = groups;

      const firstResponse = await fixture.request(
        '/push-live',
        'POST',
        {
          hashes: first.hashes,
          expected: await reviewed([first.value], fixture.aliases),
        },
        2,
      );
      expect(firstResponse.status).toBe(200);
      const firstDigest = await publishableHash(first.value, fixture.aliases);
      expect(await firstResponse.json()).toMatchObject({
        liveCommit: fixture.liveHead,
        commit: fixture.dataHead,
        pushed: { [first.value.hash]: firstDigest },
      });
      expect(fixture.current()['live/pushed.json']).toEqual({
        ...values.markers,
        [first.value.hash]: firstDigest,
      });
      expect(fixture.current()[`live/tooltips/${first.value.hash}.json`]).toEqual(first.value);
      const oldSecond = second.value.hash === 123 ? values.previous : values.oldUnchanged;
      expect(fixture.current()[`live/tooltips/${second.value.hash}.json`]).toEqual(oldSecond);
      for (const hash of [second.value.hash, ...second.aliases]) {
        // Unselected legacy copies are intentional rollout residue, not dangling references.
        expect(livePerks(fixture)[hash]).toEqual(initialPerks[hash]);
      }
      expect(danglingReferences(livePerks(fixture))).toEqual([]);
      const firstLive = structuredClone(livePerks(fixture));

      vi.setSystemTime(nextPushTime);
      const secondResponse = await fixture.request('/push-live', 'POST', {
        hashes: second.hashes,
        expected: await reviewed([second.value], fixture.aliases),
      });
      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toMatchObject({
        pushed: await reviewed([second.value], fixture.aliases),
      });
      for (const hash of [first.value.hash, ...first.aliases]) {
        expect(livePerks(fixture)[hash]).toEqual(firstLive[hash]);
      }
      expect(livePerks(fixture)['123']).toMatchObject({
        editor: { en: { main: 'reviewed changed text', secondary: 'reviewed changed text' } },
        associated: [234, 999],
        lastUpload: changedFirst ? pushTime : nextPushTime,
        uploadedBy: changedFirst ? 'bob' : 'alice',
      });
      expect(livePerks(fixture)['234']).toMatchObject({
        lastUpload: 111,
        uploadedBy: 'unchanged uploader',
      });
      expect(livePerks(fixture)['345']).toEqual({
        hash: 345,
        aliasOf: 123,
        aliasKind: 'frame',
        name: 'Member 345',
        type: 'Weapon Perk',
        itemHash: 2345,
      });
      expect(livePerks(fixture)['456']).toEqual({
        hash: 456,
        aliasOf: 234,
        aliasKind: 'frame',
        name: 'Member 456',
        type: 'Weapon Perk',
        itemHash: 2456,
      });
      expect(livePerks(fixture)['789']).toEqual({ hash: 789, aliasOf: 123, aliasKind: 'sandbox' });
      expect(livePerks(fixture)['890']).toEqual({ hash: 890, aliasOf: 234, aliasKind: 'sandbox' });
      expect(danglingReferences(livePerks(fixture))).toEqual([]);
      expect(fixture.current()['live/pushed.json']).toEqual({
        ...values.markers,
        ...(await reviewed([values.changed, values.unchanged], fixture.aliases)),
      });
      for (const value of [values.changed, values.unchanged, values.unrelated]) {
        expect(fixture.current()[`live/tooltips/${value.hash}.json`]).toEqual(value);
      }
      expect(fixture.current()['tooltips/123.json']).toEqual(values.changed);
      expect(fixture.current()['tooltips/234.json']).toEqual(values.unchanged);
      expect(livePerks(fixture)['999']).toEqual(initialPerks['999']);
      expect(livePerks(fixture)['1001']).toEqual(initialPerks['1001']);
      expect(fixture.live.databaseSettings).toEqual(initialLive.databaseSettings);
      expect(fixture.live.rolloutNote).toEqual(initialLive.rolloutNote);
      expect(fixture.writes).toHaveLength(2);
      expect(fixture.commits).toHaveLength(2);
    },
  );

  it('reselects a canonical through another alias without restamping or duplicating markers', async () => {
    const { changed, unchanged, markers } = await seedPushGroups(fixture);
    expect(
      (
        await fixture.request(
          '/push-live',
          'POST',
          {
            hashes: [789],
            expected: await reviewed([changed], fixture.aliases),
          },
          2,
        )
      ).status,
    ).toBe(200);
    const firstEntry = structuredClone(livePerks(fixture)['123']);
    vi.setSystemTime(nextPushTime);
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [345, 123, 890],
      expected: await reviewed([changed, unchanged], fixture.aliases),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).pushed).toEqual(
      await reviewed([changed, unchanged], fixture.aliases),
    );
    expect(livePerks(fixture)['123']).toEqual(firstEntry);
    expect(fixture.current()['live/pushed.json']).toEqual({
      ...markers,
      ...(await reviewed([changed, unchanged], fixture.aliases)),
    });
    expect(danglingReferences(livePerks(fixture))).toEqual([]);
  });

  it('requires canonical review digests even when only an alias is selected', async () => {
    const { changed } = await seedPushGroups(fixture);
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [789],
      expected: { 789: await publishableHash(changed, fixture.aliases) },
    });
    expect(response.status).toBe(409);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it('does not advance an earlier batch when later generator facts are missing', async () => {
    const { changed, unchanged } = await seedPushGroups(fixture);
    expect((await fixture.request('/push-live', 'POST', { hashes: [789] })).status).toBe(200);
    const live = structuredClone(fixture.live);
    const data = structuredClone(fixture.current());
    delete fixture.extraItems['234'];
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [890],
      expected: await reviewed([unchanged], fixture.aliases),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Missing generator facts for tooltip 234' });
    expect(fixture.live).toEqual(live);
    expect(fixture.current()).toEqual(data);
    expect(fixture.current()['live/pushed.json']).toMatchObject(
      await reviewed([changed], fixture.aliases),
    );
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.commits).toHaveLength(1);
  });

  it('distinguishes stale full copies from broken or indirect reference closure', () => {
    const canonical = { hash: 123, editor: { en: { main: 'old text' } } };
    const stub = { hash: 789, aliasOf: 123, aliasKind: 'sandbox' };
    expect(
      danglingReferences({ 123: canonical, 456: { ...canonical, hash: 456 }, 789: stub }),
    ).toEqual([]);
    expect(danglingReferences({ 789: stub })).toEqual(['789']);
    expect(
      danglingReferences({
        123: { hash: 123, aliasOf: 234 },
        789: stub,
      }),
    ).toEqual(['123', '789']);
  });
});

describe('push-live selection boundary', () => {
  it('rejects 101 distinct canonicals, then publishes them as 100 plus 1 with all alias groups', async () => {
    const values: Tooltip[] = Array.from({ length: 101 }, (_, index) => ({
      ...tooltip(`Batch text ${index}`),
      hash: index + 2000,
    }));
    fixture.extraItems = Object.fromEntries(
      values.map(({ hash }) => [hash, { hash, name: `Perk ${hash}`, categoryId: 'perk' }]),
    );
    fixture.aliases = Object.fromEntries(
      values.map(({ hash }) => [hash + 10_000, { to: hash, kind: 'sandbox' as const }]),
    );
    fixture.moveData({
      ...Object.fromEntries(values.map((value) => [`tooltips/${value.hash}.json`, value])),
      'live/pushed.json': { 999: 'f'.repeat(64) },
      'live/tooltips/999.json': { ...tooltip('untouched'), hash: 999 },
    });
    const initialLive = structuredClone(fixture.live);
    const initialPerks = livePerks(fixture);
    const initialData = structuredClone(fixture.current());
    const rejected = await fixture.request('/push-live', 'POST', {
      hashes: values.map(({ hash }) => hash),
    });
    expect(rejected.status).toBe(400);
    expect(fixture.live).toEqual(initialLive);
    expect(fixture.current()).toEqual(initialData);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);

    const first = values.slice(0, 100);
    const response = await fixture.request('/push-live', 'POST', {
      hashes: first.map(({ hash }, index) => (index % 2 ? hash + 10_000 : hash)),
      expected: await reviewed(first, fixture.aliases),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).pushed).toEqual(await reviewed(first, fixture.aliases));
    expect(Object.keys(livePerks(fixture))).toHaveLength(201);
    expect(fixture.current()['live/pushed.json']).toEqual({
      999: 'f'.repeat(64),
      ...(await reviewed(first, fixture.aliases)),
    });
    expect(livePerks(fixture)['2100']).toBeUndefined();
    expect(fixture.current()['live/tooltips/2100.json']).toBeUndefined();
    const firstPerks = livePerks(fixture);
    vi.setSystemTime(nextPushTime);
    expect(
      (
        await fixture.request(
          '/push-live',
          'POST',
          {
            hashes: [12_100],
            expected: await reviewed([values[100]], fixture.aliases),
          },
          2,
        )
      ).status,
    ).toBe(200);
    for (const value of values) {
      expect(livePerks(fixture)[value.hash]).toMatchObject({
        hash: value.hash,
        editor: { en: { main: value.text.en!.text } },
        lastUpload: value.hash === 2100 ? nextPushTime : pushTime,
        uploadedBy: value.hash === 2100 ? 'bob' : 'alice',
      });
      expect(livePerks(fixture)[value.hash + 10_000]).toEqual({
        hash: value.hash + 10_000,
        aliasOf: value.hash,
        aliasKind: 'sandbox',
      });
      expect(fixture.current()[`live/tooltips/${value.hash}.json`]).toEqual(value);
      if (value.hash !== 2100)
        expect(livePerks(fixture)[value.hash]).toEqual(firstPerks[value.hash]);
    }
    expect(Object.keys(livePerks(fixture))).toHaveLength(203);
    expect(fixture.current()['live/pushed.json']).toEqual({
      999: 'f'.repeat(64),
      ...(await reviewed(values, fixture.aliases)),
    });
    expect(fixture.current()['live/tooltips/999.json']).toEqual(
      initialData['live/tooltips/999.json'],
    );
    expect(livePerks(fixture)['999']).toEqual(initialPerks['999']);
    expect(fixture.live.databaseSettings).toEqual(initialLive.databaseSettings);
    expect(danglingReferences(livePerks(fixture))).toEqual([]);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.commits).toHaveLength(2);
  });

  it('applies the 101 limit before aliases can collapse to one canonical', async () => {
    fixture.aliases = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        index + 2000,
        { to: 123, kind: 'sandbox' as const },
      ]),
    );
    const hashes = [123, ...Object.keys(fixture.aliases).map(Number)];
    expect((await fixture.request('/push-live', 'POST', { hashes })).status).toBe(400);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
    expect(
      (await fixture.request('/push-live', 'POST', { hashes: hashes.slice(0, 100) })).status,
    ).toBe(200);
    expect(fixture.current()['live/pushed.json']).toEqual(
      await reviewed([tooltip()], fixture.aliases),
    );
    expect(Object.keys(livePerks(fixture))).toHaveLength(102);
  });
});
