import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishableHash, pushedSchema, type Tooltip } from '@clarity/core';
import { config, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';
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

describe('two-branch recovery across batches', () => {
  it.each(['data retries exhausted', 'live moved before marker'])(
    'surfaces %s, rejects a stale review and converges after reviewing the newer save',
    async (failure) => {
      const { changed, unchanged, previous, unrelated } = await seedPushGroups(fixture);
      const initialSettings = structuredClone(fixture.live.databaseSettings);
      const initialRoot = structuredClone(fixture.live.rolloutNote);
      expect(
        (
          await fixture.request('/push-live', 'POST', {
            hashes: [890],
            expected: await reviewed([unchanged], fixture.aliases),
          })
        ).status,
      ).toBe(200);
      const firstPerks = livePerks(fixture);
      const markers = pushedSchema.parse(fixture.current()['live/pushed.json']);
      let writtenLiveCommit = '';
      const newer: Tooltip = { ...changed, text: tooltip('newer unreviewed save').text };
      const unrelatedEdit: Tooltip = { ...unrelated, text: tooltip('unrelated pending save').text };
      fixture.beforePatch = () => {
        writtenLiveCommit = fixture.liveHead;
        fixture.moveData({
          'tooltips/123.json': newer,
          'tooltips/999.json': unrelatedEdit,
        });
        if (failure === 'live moved before marker') {
          fixture.live = {
            ...fixture.live,
            perks: {
              ...livePerks(fixture),
              555: { hash: 555, editor: { en: { main: 'concurrent unrelated live text' } } },
              556: { hash: 556, aliasOf: 555, aliasKind: 'sandbox' },
            },
          };
          fixture.liveFileSha = sha(900);
          fixture.liveHead = sha(901);
        }
      };
      if (failure === 'data retries exhausted') fixture.patchRaces = 2;
      const response = await fixture.request(
        '/push-live',
        'POST',
        {
          hashes: [789],
          expected: await reviewed([changed], fixture.aliases),
        },
        2,
      );
      expect(response.status).toBe(409);
      const result = await response.json();
      expect(result).toMatchObject({
        error:
          failure === 'data retries exhausted'
            ? 'Data branch kept moving; retry push-live to record its status'
            : 'Live changed before recording push; retry push-live',
        details: { liveCommit: writtenLiveCommit, pushedRecorded: false },
      });
      // The response identifies this operation's write, not a competing live head.
      if (failure === 'live moved before marker') {
        expect(result.details.liveCommit).not.toBe(fixture.liveHead);
      }
      expect(fixture.writes).toHaveLength(2);
      expect(fixture.commits).toHaveLength(failure === 'data retries exhausted' ? 4 : 2);
      expect(fixture.current()['live/pushed.json']).toEqual(markers);
      expect(fixture.current()['live/tooltips/123.json']).toEqual(previous);
      expect(fixture.current()['live/tooltips/234.json']).toEqual(unchanged);
      expect(fixture.current()['tooltips/123.json']).toEqual(newer);
      expect(fixture.current()['tooltips/999.json']).toEqual(unrelatedEdit);
      expect(livePerks(fixture)['123']).toMatchObject({
        editor: { en: { main: changed.text.en!.text } },
        lastUpload: pushTime,
        uploadedBy: 'bob',
      });
      expect(livePerks(fixture)['789']).toEqual({ hash: 789, aliasOf: 123, aliasKind: 'sandbox' });
      expect(danglingReferences(livePerks(fixture))).toEqual([]);
      expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
        pushedHash: await publishableHash(previous, fixture.aliases),
        tooltip: previous,
      });

      const partialLive = structuredClone(fixture.live);
      const partialPerks = livePerks(fixture);
      const partialData = structuredClone(fixture.current());
      const rejected = await fixture.request('/push-live', 'POST', {
        hashes: [123, 345],
        expected: await reviewed([changed], fixture.aliases),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({
        error: 'Tooltip 123 changed since review; refresh saved changes',
      });
      expect(fixture.live).toEqual(partialLive);
      expect(fixture.current()).toEqual(partialData);
      expect(fixture.writes).toHaveLength(2);
      expect(pushedSchema.parse(fixture.current()['live/pushed.json'])['123']).not.toBe(
        await publishableHash(newer, fixture.aliases),
      );

      vi.setSystemTime(nextPushTime);
      const retry = await fixture.request('/push-live', 'POST', {
        hashes: [345, 789],
        expected: await reviewed([newer], fixture.aliases),
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        commit: fixture.dataHead,
        liveCommit: fixture.liveHead,
        pushed: await reviewed([newer], fixture.aliases),
      });
      expect(fixture.current()['live/pushed.json']).toEqual({
        ...markers,
        ...(await reviewed([newer], fixture.aliases)),
      });
      expect(fixture.current()['live/tooltips/123.json']).toEqual(newer);
      expect(fixture.current()['live/tooltips/234.json']).toEqual(unchanged);
      expect(fixture.current()['live/tooltips/999.json']).toEqual(unrelated);
      expect(fixture.current()['tooltips/999.json']).toEqual(unrelatedEdit);
      expect(livePerks(fixture)['123']).toMatchObject({
        editor: { en: { main: newer.text.en!.text } },
        lastUpload: nextPushTime,
        uploadedBy: 'alice',
      });
      for (const hash of [234, 456, 890, 999, 1001]) {
        expect(livePerks(fixture)[hash]).toEqual(firstPerks[hash]);
      }
      for (const hash of [555, 556]) expect(livePerks(fixture)[hash]).toEqual(partialPerks[hash]);
      expect(fixture.live.databaseSettings).toEqual(initialSettings);
      expect(fixture.live.rolloutNote).toEqual(initialRoot);
      expect(danglingReferences(livePerks(fixture))).toEqual([]);
      expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
        pushedHash: await publishableHash(newer, fixture.aliases),
        tooltip: newer,
      });
      expect(fixture.writes).toHaveLength(3);
      expect(fixture.commits).toHaveLength(failure === 'data retries exhausted' ? 5 : 3);
    },
  );

  it('keeps a newer save pending when a later batch successfully retries its marker commit', async () => {
    const { changed, unchanged, markers } = await seedPushGroups(fixture);
    expect((await fixture.request('/push-live', 'POST', { hashes: [890] })).status).toBe(200);
    const newer: Tooltip = { ...changed, text: tooltip('saved during marker commit').text };
    fixture.beforePatch = () => fixture.moveData({ 'tooltips/123.json': newer });
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [789],
      expected: await reviewed([changed], fixture.aliases),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).pushed).toEqual(await reviewed([changed], fixture.aliases));
    expect(fixture.current()['live/pushed.json']).toEqual({
      ...markers,
      ...(await reviewed([changed, unchanged], fixture.aliases)),
    });
    expect(fixture.current()['tooltips/123.json']).toEqual(newer);
    expect(fixture.current()['live/tooltips/123.json']).toEqual(changed);
    expect(fixture.current()['live/tooltips/234.json']).toEqual(unchanged);
    expect(pushedSchema.parse(fixture.current()['live/pushed.json'])['123']).not.toBe(
      await publishableHash(newer, fixture.aliases),
    );
    expect(livePerks(fixture)['123']).toMatchObject({
      editor: { en: { main: changed.text.en!.text } },
    });
    expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
      pushedHash: await publishableHash(changed, fixture.aliases),
      tooltip: changed,
    });
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.commits).toHaveLength(3);
    expect(danglingReferences(livePerks(fixture))).toEqual([]);
  });

  it('re-reads live entries and markers on a later batch PUT race, preserving the concurrent stamp', async () => {
    const { changed, unchanged, markers } = await seedPushGroups(fixture);
    expect((await fixture.request('/push-live', 'POST', { hashes: [890] })).status).toBe(200);
    const unchangedGroup = livePerks(fixture);
    const digest = await publishableHash(changed, fixture.aliases);
    fixture.beforeLive = () => {
      fixture.moveData({
        'live/pushed.json': { ...markers, 123: digest },
        'live/tooltips/123.json': changed,
      });
      fixture.live = {
        ...fixture.live,
        perks: {
          ...livePerks(fixture),
          123: {
            hash: 123,
            editor: { en: { main: changed.text.en!.text } },
            lastUpload: 777,
            uploadedBy: 'concurrent editor',
          },
          555: { hash: 555, editor: { en: { main: 'concurrent unrelated' } } },
        },
      };
      fixture.liveHead = sha(900);
      fixture.liveFileSha = sha(901);
    };
    vi.setSystemTime(nextPushTime);
    const response = await fixture.request(
      '/push-live',
      'POST',
      {
        hashes: [123, 789],
        expected: await reviewed([changed], fixture.aliases),
      },
      2,
    );
    expect(response.status).toBe(200);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1].sha).toBe(sha(901));
    expect(livePerks(fixture)['123']).toMatchObject({
      lastUpload: 777,
      uploadedBy: 'concurrent editor',
    });
    expect(livePerks(fixture)['555']).toEqual({
      hash: 555,
      editor: { en: { main: 'concurrent unrelated' } },
    });
    for (const hash of [234, 456, 890]) {
      expect(livePerks(fixture)[hash]).toEqual(unchangedGroup[hash]);
    }
    expect(fixture.current()['live/pushed.json']).toEqual({
      ...markers,
      ...(await reviewed([changed, unchanged], fixture.aliases)),
    });
    expect(fixture.current()['live/tooltips/123.json']).toEqual(changed);
    expect(fixture.current()['live/tooltips/234.json']).toEqual(unchanged);
    expect(danglingReferences(livePerks(fixture))).toEqual([]);
  });

  it('surfaces permission revocation after a live write and requires restored access to recover', async () => {
    const { changed, unchanged } = await seedPushGroups(fixture);
    expect((await fixture.request('/push-live', 'POST', { hashes: [890] }, 2)).status).toBe(200);
    const before = structuredClone(fixture.current());
    const denied = structuredClone(config);
    denied.users['2'] = { login: 'bob', role: 'translator', languages: ['de'] };
    fixture.beforePatch = () => fixture.moveData({ 'config/permissions.json': denied });
    const response = await fixture.request(
      '/push-live',
      'POST',
      {
        hashes: [789],
        expected: await reviewed([changed], fixture.aliases),
      },
      2,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      details: { liveCommit: fixture.liveHead, pushedRecorded: false },
    });
    expect(fixture.current()['live/pushed.json']).toEqual(before['live/pushed.json']);
    expect(fixture.current()['live/tooltips/123.json']).toEqual(before['live/tooltips/123.json']);
    expect(fixture.current()['live/tooltips/234.json']).toEqual(unchanged);
    const partialLive = structuredClone(fixture.live);
    expect((await fixture.request('/push-live', 'POST', { hashes: [789] }, 2)).status).toBe(403);
    expect(fixture.live).toEqual(partialLive);
    expect(fixture.writes).toHaveLength(2);
    fixture.moveData({ 'config/permissions.json': config });
    vi.setSystemTime(nextPushTime);
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
    expect(fixture.current()['live/pushed.json']).toMatchObject(
      await reviewed([changed, unchanged], fixture.aliases),
    );
    expect(fixture.current()['live/tooltips/123.json']).toEqual(changed);
    expect(livePerks(fixture)['123']).toMatchObject({
      lastUpload: nextPushTime,
      uploadedBy: 'bob',
    });
    expect(danglingReferences(livePerks(fixture))).toEqual([]);
  });
});
