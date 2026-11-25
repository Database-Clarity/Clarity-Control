import { afterEach, expect, it, vi } from 'vitest';
import { publishableHash, translationEnglishGate } from '@clarity/core';
import { config, Fixture, makePrivateKey, tooltip } from './fixture.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));
afterEach(() => vi.unstubAllGlobals());

it.each([2, 3, 4])('checks role %s when English is restored after removal', async (role) => {
  const fixture = new Fixture(await makePrivateKey());
  const live = tooltip('original', new Date(Date.now() - 1000).toISOString());
  const de = {
    text: 'Deutsch',
    updatedAt: '2026-09-30T00:00:00Z',
    updatedBy: 'dan',
    sourceUpdatedAt: '2026-09-30T00:00:00Z',
  };
  live.text.de = de;
  fixture.moveData({
    'tooltips/123.json': live,
    'live/tooltips/123.json': live,
    'live/pushed.json': { 123: await publishableHash(live) },
    'config/permissions.json': {
      users: { ...config.users, 4: { ...config.users[4], languages: ['en', 'de'] } },
    },
  });
  const removed = { ...live, text: { de } };
  const readded = tooltip('changed wording', live.text.en!.updatedAt);
  readded.text.de = de;
  const save = (base: typeof live, next: typeof live, as = role) =>
    fixture.request(
      '/save',
      'POST',
      { changes: [{ hash: 123, base, next }], message: 'Edit tooltip' },
      as,
    );

  const first = await save(live, removed, role === 4 ? 2 : role);
  expect(first.status, await first.clone().text()).toBe(200);
  const second = await save(removed, readded);
  if (role === 2) {
    expect(second.status, await second.clone().text()).toBe(200);
    expect(fixture.current()['tooltips/123.json']).toEqual(readded);
    expect(fixture.commits[1]?.message).toBe('Edit tooltip\n\nClarity-Changed: 123=en');
    // Root accepted this trusted-role case. The gate opens, and scoped output uses live.text.en.
    expect(
      translationEnglishGate({
        kind: 'tooltip',
        hash: live.hash,
        saved: readded,
        live: { status: 'active', entry: live },
        liveAliases: {},
      }),
    ).toEqual({ status: 'ready' });
  } else {
    expect(second.status, await second.clone().text()).toBe(role === 3 ? 422 : 403);
    expect(fixture.current()['tooltips/123.json']).toEqual(removed);
    expect(fixture.commits).toHaveLength(1);
    if (role === 3) {
      // An older restore would allow a later edit to advance back to the published stamp.
      const earlier = tooltip(
        'Changed wording with an older stamp',
        new Date(Date.parse(live.text.en!.updatedAt) - 1).toISOString(),
      );
      earlier.text.de = de;
      expect((await save(removed, earlier)).status).toBe(422);
      const fresh = tooltip('changed wording', new Date().toISOString());
      fresh.text.de = de;
      const response = await save(removed, fresh);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(fixture.current()['tooltips/123.json']).toEqual(fresh);
      const retry = await save(removed, fresh);
      expect(retry.status, await retry.clone().text()).toBe(200);
    }
  }
});

it('lets a trial write the first English into a saved link-only tooltip', async () => {
  const fixture = new Fixture(await makePrivateKey());
  const next = {
    ...tooltip('First English', new Date().toISOString()),
    compendium: {
      gid: '1662574278',
      rowKey: 'Demo',
      snapshot: { plain: '', runs: [] },
      snapshotAt: '2026-10-02T00:00:00Z',
    },
  };
  const base = { ...next, text: {} };
  fixture.moveData({ 'tooltips/123.json': base });
  const response = await fixture.request(
    '/save',
    'POST',
    { changes: [{ hash: 123, base, next }], message: 'Write first English' },
    3,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(fixture.current()['tooltips/123.json']).toEqual(next);
});
