import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash, publishableHash, type Permissions } from '@clarity/core';
import { config, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('push-live', () => {
  it('publishes canonical text once and writes frame and sandbox aliases as reference stubs', async () => {
    fixture.aliases = {
      456: { to: 123, kind: 'frame' },
      789: { to: 456, kind: 'sandbox' },
    };
    fixture.extraItems = {
      456: { hash: 456, name: 'Another frame', categoryId: 'perk', itemHash: 222 },
    };
    const response = await fixture.request('/push-live', 'POST', { hashes: [123, 456, 789] });
    expect(response.status).toBe(200);
    expect(fixture.live).toMatchObject({
      perks: {
        123: { hash: 123, editor: { en: { main: 'original' } } },
      },
    });
    const published = (fixture.live as { perks: Record<string, unknown> }).perks;
    // Stubs are written as-is: own facts only, no editor text, no stamping.
    expect(published['456']).toEqual({
      hash: 456,
      aliasOf: 123,
      aliasKind: 'frame',
      name: 'Another frame',
      type: 'Weapon Perk',
      itemHash: 222,
    });
    expect(published['789']).toEqual({ hash: 789, aliasOf: 123, aliasKind: 'sandbox' });
    expect(fixture.current()['live/pushed.json']).toEqual({
      123: await publishableHash(tooltip(), fixture.aliases),
    });
  });
  it('ignores retired weapon facts and never writes owner metadata', async () => {
    fixture.aliases = { 456: { to: 123, kind: 'frame' } };
    fixture.canonicalFacts = {
      weaponTypes: ['Bow', 'Sniper'],
      owners: [1, 2],
      ownerNames: { 1: 'First exotic', 2: 'Second exotic' },
    };
    fixture.extraItems = {
      456: {
        hash: 456,
        name: 'Another frame',
        categoryId: 'perk',
        weaponTypes: ['Bow'],
        owners: [3, 4],
        ownerNames: { 3: 'Third exotic', 4: 'Fourth exotic' },
      },
    };
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    const published = (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(published['123']).not.toHaveProperty('weaponTypes');
    expect(published['456']).toMatchObject({ aliasOf: 123 });
    expect(published['456']).not.toHaveProperty('weaponTypes');
    for (const hash of ['123', '456']) {
      expect(published[hash]).not.toHaveProperty('owners');
      expect(published[hash]).not.toHaveProperty('ownerNames');
    }
  });
  it('publishes without the retired label service and preserves existing settings', async () => {
    fixture.weaponTypeStatus = 500;
    const settings = { folders: { custom: [] }, weaponTypeLabels: { broken: true } };
    fixture.live = { ...(fixture.live as object), databaseSettings: settings };
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(fixture.live).toMatchObject({ databaseSettings: settings });
  });
  it('writes associations as a sorted canonical list and omits it otherwise', async () => {
    fixture.moveData({ 'tooltips/123.json': { ...tooltip(), associated: [900, 200, 456] } });
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(fixture.live).toMatchObject({ perks: { 123: { associated: [900, 200, 456] } } });
    expect((fixture.live as { perks: Record<string, unknown> }).perks['999']).not.toHaveProperty(
      'associated',
    );
  });
  it.each([1, 2])(
    'lets role id %s export selected entries and aliases without replacing other entries',
    async (id) => {
      const response = await fixture.request('/push-live', 'POST', { hashes: [123] }, id);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.branch).toBe('converter-v2-test');
      expect(fixture.writes[0]).toMatchObject({
        branch: 'converter-v2-test',
        sha: sha(3),
        author: {
          name: config.users[String(id)].login,
          email: `${id}+${config.users[String(id)].login}@users.noreply.github.com`,
        },
        committer: { name: 'clarity-test[bot]' },
      });
      expect(fixture.live).toMatchObject({
        perks: {
          '123': {
            hash: 123,
            name: 'Demo perk',
            type: 'Weapon Perk',
            itemHash: 456,
            itemName: 'Demo item',
            editor: { en: { main: 'original', secondary: 'original' } },
          },
          '999': { hash: 999, editor: { en: { main: 'untouched' } } },
        },
        databaseSettings: { folders: { saved: [] } },
      });
      expect((fixture.live as { perks: Record<string, unknown> }).perks['789']).toEqual({
        hash: 789,
        aliasOf: 123,
        aliasKind: 'sandbox',
      });
      expect(fixture.current()['live/pushed.json']).toEqual({
        '123': await publishableHash(tooltip(), fixture.aliases),
      });
      expect(result.pushed).toEqual(fixture.current()['live/pushed.json']);
    },
  );

  describe('upload stamping', () => {
    const now = 1_900_000_000_000;
    type Perks = Record<string, { lastUpload?: number; uploadedBy?: string }>;
    const perks = () => (fixture.live as { perks: Perks }).perks;
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now }));
    afterEach(() => vi.useRealTimers());

    it('stamps a changed or brand-new canonical tooltip with the pusher and push time, never its alias stub', async () => {
      fixture.moveData({
        'tooltips/123.json': { ...tooltip(), legacy: { uploadedBy: 'old', lastUpload: 5 } },
      });
      expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, 2)).status).toBe(200);
      expect(perks()['123']).toMatchObject({ uploadedBy: 'bob', lastUpload: now });
      expect(perks()['789']).not.toHaveProperty('lastUpload');
      expect(perks()['789']).not.toHaveProperty('uploadedBy');
      expect(perks()['999']).not.toHaveProperty('lastUpload');
    });

    it('stamps a tooltip whose publishable hash differs from the pushed marker', async () => {
      fixture.moveData({ 'live/pushed.json': { '123': 'a'.repeat(64) } });
      fixture.live = {
        ...fixture.live,
        perks: { ...perks(), '123': { lastUpload: 7, uploadedBy: 'old' } },
      };
      expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
      expect(perks()['123']).toMatchObject({ uploadedBy: 'alice', lastUpload: now });
    });

    it('keeps the live stamp of an unchanged canonical tooltip and replaces an old alias copy with a stub', async () => {
      fixture.moveData({
        'live/pushed.json': { '123': await publishableHash(tooltip(), fixture.aliases) },
      });
      fixture.live = {
        ...fixture.live,
        perks: {
          ...perks(),
          '123': { lastUpload: 111, uploadedBy: 'old' },
          '789': { lastUpload: 222, uploadedBy: 'older' },
        },
      };
      expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, 2)).status).toBe(200);
      expect(perks()['123']).toMatchObject({ lastUpload: 111, uploadedBy: 'old' });
      expect(perks()['789']).toEqual({ hash: 789, aliasOf: 123, aliasKind: 'sandbox' });
    });

    it('leaves exported values for an unchanged tooltip with no live entry', async () => {
      fixture.moveData({
        'tooltips/123.json': { ...tooltip(), legacy: { uploadedBy: 'migrated', lastUpload: 42 } },
        'live/pushed.json': { '123': await publishableHash(tooltip(), fixture.aliases) },
      });
      expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, 2)).status).toBe(200);
      expect(perks()['123']).toMatchObject({ lastUpload: 42, uploadedBy: 'migrated' });
      expect(perks()['789']).not.toHaveProperty('lastUpload');
    });

    it('re-reads pushed and live data when retrying after a live race', async () => {
      const unchanged = await publishableHash(tooltip(), fixture.aliases);
      fixture.beforeLive = () => {
        // A concurrent push recorded the same content and wrote its own stamp meanwhile.
        fixture.moveData({ 'live/pushed.json': { '123': unchanged } });
        fixture.live = {
          ...fixture.live,
          perks: { ...perks(), '123': { lastUpload: 5, uploadedBy: 'carol' } },
        };
        fixture.liveFileSha = sha(88);
        fixture.liveHead = sha(89);
      };
      expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.writes[0].sha).toBe(sha(88));
      expect(perks()['123']).toMatchObject({ lastUpload: 5, uploadedBy: 'carol' });
    });
  });

  it.each([3, 4, 5])('denies push-live for role id %s', async (id) => {
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, id)).status).toBe(403);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it('retries a SHA-checked live PUT and retains concurrent unrelated edits', async () => {
    fixture.beforeLive = () => {
      fixture.live = { ...fixture.live, perks: { '555': { hash: 555, editor: {} } } };
      fixture.liveFileSha = sha(88);
      fixture.liveHead = sha(89);
    };
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(fixture.writes[0].sha).toBe(sha(88));
    expect(fixture.live).toMatchObject({ perks: { '555': { hash: 555 }, '123': { hash: 123 } } });
  });

  it('reads large GitHub Contents responses through the blob API', async () => {
    fixture.largeFile = true;
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(fixture.blobReads).toBe(1);
    expect(fixture.live).toMatchObject({ perks: { '123': { hash: 123 } } });
  });

  it('bounds live-SHA races and never marks an unsuccessful export', async () => {
    fixture.liveRaces = 3;
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(409);
    expect(fixture.current()['live/pushed.json']).toEqual({});
    expect(fixture.commits).toHaveLength(0);
    expect(fixture.writes).toHaveLength(0);
  });

  it('reports a completed live export whose marker retries are exhausted', async () => {
    fixture.patchRaces = 3;
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      details: {
        liveCommit: fixture.liveHead,
        pushedRecorded: false,
      },
    });

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.current()['live/pushed.json']).toEqual({});
  });

  it('surfaces partial publishing even when marker data is malformed', async () => {
    fixture.moveData({ 'live/pushed.json': { '123': 'invalid hash' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        details: { liveCommit: fixture.liveHead, pushedRecorded: false },
      });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('records exported content hashes, not edits made after exporting', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({
        'tooltips/123.json': tooltip('changed after export'),
        'live/pushed.json': { '999': 'f'.repeat(64) },
      });
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(200);
    expect(fixture.current()['live/pushed.json']).toEqual({
      '123': await publishableHash(tooltip(), fixture.aliases),
      '999': 'f'.repeat(64),
    });
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip('changed after export'));
  });

  it('records publishable hashes without edit metadata or snapshots', async () => {
    const metadataOnly = tooltip();
    metadataOnly.text.en = {
      ...metadataOnly.text.en!,
      updatedAt: '2026-10-27T00:00:00Z',
      updatedBy: 'bob',
    };
    metadataOnly.legacy = { uploadedBy: 'bob', lastUpload: 1000 };
    metadataOnly.bungieSnapshot = {
      description: 'new snapshot',
      snapshotAt: '2026-10-27T00:00:00Z',
    };
    fixture.moveData({ 'tooltips/123.json': metadataOnly });
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    const expected = await publishableHash(tooltip(), fixture.aliases);
    expect(expected).not.toBe(await contentHash(metadataOnly));
    expect(fixture.current()['live/pushed.json']).toEqual({ '123': expected });
  });

  it('reports a partial push explicitly if live changes before the marker commit', async () => {
    fixture.beforePatch = () => {
      fixture.liveHead = sha(1000);
      fixture.moveData();
    };
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      details: {
        liveCommit: expect.any(String),
        pushedRecorded: false,
      },
    });
    expect(fixture.current()['live/pushed.json']).toEqual({});
  });

  it('rejects a review digest taken before a translation-fallback flip', async () => {
    const stamp = '2026-10-01T00:00:00Z';
    const german = () =>
      (fixture.live as { perks: Record<string, { editor: { de: { main: string } } }> }).perks['123']
        ?.editor.de.main;
    const current = (sourceUpdatedAt: string) => ({
      ...tooltip('English'),
      text: {
        en: { text: 'English', updatedAt: stamp, updatedBy: 'alice' },
        de: { text: 'Deutsch', updatedAt: stamp, updatedBy: 'dan', sourceUpdatedAt },
      },
    });
    fixture.moveData({ 'tooltips/123.json': current(stamp) });
    const reviewed = await publishableHash(current(stamp), fixture.aliases);
    const first = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: reviewed },
    });
    expect(first.status).toBe(200);
    expect(german()).toBe('Deutsch');
    // Metadata-only change (no text change) flips the exported German text to English.
    fixture.moveData({ 'tooltips/123.json': current('2026-01-01T00:00:00Z') });
    const stale = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: reviewed },
    });
    expect(stale.status).toBe(409);
    expect(german()).toBe('Deutsch');
    const fresh = await publishableHash(current('2026-01-01T00:00:00Z'), fixture.aliases);
    expect(fresh).not.toBe(reviewed);
    const second = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: fresh },
    });
    expect(second.status).toBe(200);
    expect(german()).toBe('English');
  });
  it('invalidates a review digest when an alias is added or retargeted, and publishes its stub', async () => {
    const reviewed = await publishableHash(tooltip(), fixture.aliases);
    expect(
      (await fixture.request('/push-live', 'POST', { hashes: [123], expected: { 123: reviewed } }))
        .status,
    ).toBe(200);
    fixture.aliases = { ...fixture.aliases, 790: { to: 123, kind: 'frame' } };
    fixture.extraItems = {
      790: { hash: 790, name: 'New frame', categoryId: 'perk', itemHash: 333 },
    };
    const stale = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: reviewed },
    });
    expect(stale.status).toBe(409);
    const fresh = await publishableHash(tooltip(), fixture.aliases);
    expect(fresh).not.toBe(reviewed);
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: fresh },
    });
    expect(response.status).toBe(200);
    const perks = (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks['790']).toMatchObject({ hash: 790, aliasOf: 123, aliasKind: 'frame' });
    expect(fixture.current()['live/pushed.json']).toEqual({ 123: fresh });
  });
  it('does not export missing tooltips or malformed/duplicate hash selections', async () => {
    expect((await fixture.request('/push-live', 'POST', { hashes: [456] })).status).toBe(404);
    expect((await fixture.request('/push-live', 'POST', { hashes: [123, 123] })).status).toBe(400);
    expect((await fixture.request('/push-live', 'POST', { hashes: [] })).status).toBe(400);
    expect(fixture.writes).toHaveLength(0);
  });
});

describe('permissions and history', () => {
  it.each([403, 429, 500])(
    'surfaces GitHub upstream status %s without writing defaults',
    async (status) => {
      fixture.upstreamStatus = status;
      const response = await fixture.request('/me');
      expect(response.status).toBe(status === 500 ? 502 : 503);
      expect(await response.json()).toHaveProperty('error');
      expect(fixture.commits).toHaveLength(0);
    },
  );
  it.each([2, 3, 4, 5])('denies GET and PUT /permissions for role id %s', async (id) => {
    expect((await fixture.request('/permissions', 'GET', undefined, id)).status).toBe(403);
    expect(
      (await fixture.request('/permissions', 'PUT', { revision: sha(4), permissions: config }, id))
        .status,
    ).toBe(403);
  });

  async function loadPermissions(): Promise<{ revision: string; permissions: Permissions }> {
    return (await (await fixture.request('/permissions')).json()) as {
      revision: string;
      permissions: Permissions;
    };
  }
  const withCarolEditor = (): Permissions => {
    const next: Permissions = structuredClone(config);
    next.users['3'] = { login: 'carol', role: 'editor' };
    return next;
  };
  const withoutBob = (): Permissions => {
    const next: Permissions = structuredClone(config);
    delete next.users['2'];
    return next;
  };

  it('lets maintainers update roles and immediately uses the new configuration', async () => {
    const loaded = await loadPermissions();
    expect(loaded.permissions).toEqual(config);
    const next: Permissions = structuredClone(config);
    next.users['2'] = { login: 'bob', role: 'translator', languages: ['ja'] };
    const result = await fixture.request('/permissions', 'PUT', {
      revision: loaded.revision,
      permissions: next,
    });
    expect(result.status).toBe(200);
    const saved = (await result.json()) as { revision: string; permissions: Permissions };
    expect(saved.permissions).toEqual(next);
    expect(saved.revision).toBe((await loadPermissions()).revision);
    expect(saved.revision).not.toBe(loaded.revision);
    expect(await (await fixture.request('/me', 'GET', undefined, 2)).json()).toEqual({
      id: 2,
      login: 'bob',
      role: 'translator',
      languages: ['ja'],
    });
    const empty = await fixture.request('/permissions', 'PUT', {
      revision: saved.revision,
      permissions: { users: {} },
    });
    expect(empty.status).toBe(400);
  });

  it('rejects a stale permissions save instead of restoring a revoked editor', async () => {
    const tabA = await loadPermissions();
    const tabB = await loadPermissions();
    const revoke = await fixture.request('/permissions', 'PUT', {
      revision: tabA.revision,
      permissions: withoutBob(),
    });
    expect(revoke.status).toBe(200);
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, 2)).status).toBe(403);
    const commits = fixture.commits.length;
    const response = await fixture.request('/permissions', 'PUT', {
      revision: tabB.revision,
      permissions: withCarolEditor(),
    });
    expect(response.status).toBe(409);
    expect(fixture.commits).toHaveLength(commits);
    expect(await (await fixture.request('/me', 'GET', undefined, 2)).json()).toMatchObject({
      role: null,
    });
    expect(fixture.current()['config/permissions.json']).toEqual(withoutBob());
  });

  it('rejects a revocation that lands during the ref update instead of retrying a stale body', async () => {
    const tab = await loadPermissions();
    fixture.beforePatch = () => fixture.moveData({ 'config/permissions.json': withoutBob() });
    const response = await fixture.request('/permissions', 'PUT', {
      revision: tab.revision,
      permissions: withCarolEditor(),
    });
    expect(response.status).toBe(409);
    expect(fixture.current()['config/permissions.json']).toEqual(withoutBob());
    expect(await (await fixture.request('/me', 'GET', undefined, 2)).json()).toMatchObject({
      role: null,
    });
  });

  it('retries a ref race when the permissions themselves did not change', async () => {
    const tab = await loadPermissions();
    fixture.beforePatch = () => fixture.moveData({ 'tooltips/123.json': tooltip('newer save') });
    const response = await fixture.request('/permissions', 'PUT', {
      revision: tab.revision,
      permissions: withCarolEditor(),
    });
    expect(response.status).toBe(200);
    expect(fixture.current()['config/permissions.json']).toEqual(withCarolEditor());
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip('newer save'));
  });

  it.each([
    ['a body without a revision', undefined],
    ['a malformed revision', 'not-a-sha'],
    ['a forged revision', sha(99)],
  ])('refuses PUT /permissions with %s', async (_label, revision) => {
    const next = withCarolEditor();
    const input = revision === undefined ? next : { revision, permissions: next };
    const response = await fixture.request('/permissions', 'PUT', input);
    expect([400, 409]).toContain(response.status);
    expect(fixture.current()['config/permissions.json']).toEqual(config);
  });

  it('loads /me for known and unknown users without trusting caller role values', async () => {
    expect(await (await fixture.request('/me', 'GET', undefined, 5)).json()).toEqual({
      id: 5,
      login: 'unknown',
      role: null,
      languages: [],
    });
    expect(await (await fixture.request('/me', 'GET', undefined, 4)).json()).toMatchObject({
      role: 'translator',
      languages: ['de'],
    });
  });

  it('lists per-tooltip history and reads a particular immutable commit', async () => {
    const result = await fixture.request('/history/123?page=1');
    expect(await result.json()).toEqual({
      page: 1,
      commits: [
        {
          commit: sha(1),
          author: 'alice',
          login: 'alice',
          avatar: null,
          date: '2026-10-01T00:00:00Z',
          message: 'initial',
        },
      ],
    });
    expect(await (await fixture.request(`/history/123?commit=${sha(1)}`)).json()).toEqual({
      commit: sha(1),
      tooltip: tooltip(),
    });
    expect((await fixture.request('/history/123?commit=main')).status).toBe(400);
    expect((await fixture.request('/history/123?page=-1')).status).toBe(400);
    expect((await fixture.request('/history/4294967296')).status).toBe(400);
    expect((await fixture.request(`/history/999?commit=${sha(1)}`)).status).toBe(404);
    expect((await fixture.request('/history/123', 'GET', undefined, 5)).status).toBe(403);
  });
});

it('refuses empty selections before any live or marker write', async () => {
  fixture.moveData({ 'tooltips/123.json': { ...tooltip(), text: {} } });
  const before = structuredClone(fixture.live);
  const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
  expect(response.status).toBe(422);
  expect(fixture.live).toEqual(before);
  expect(fixture.commits).toHaveLength(0);
});

it.each([125, 456])(
  'refuses association %s to an empty saved target before live writes',
  async (target) => {
    fixture.aliases = { 456: { to: 125, kind: 'frame' } };
    fixture.moveData({
      'tooltips/123.json': { ...tooltip(), associated: [target] },
      'tooltips/125.json': { ...tooltip(), hash: 125, text: {} },
    });
    const live = structuredClone(fixture.live);
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(422);
    expect(fixture.live).toEqual(live);
    expect(fixture.commits).toHaveLength(0);
  },
);

it('allows an intentionally emptied reserved global library to be pushed', async () => {
  const global = {
    ...tooltip(),
    hash: 2,
    text: {},
    custom: { name: 'Variables', categoryId: 'global' },
  };
  fixture.moveData({ 'tooltips/2.json': global });
  const response = await fixture.request('/push-live', 'POST', { hashes: [2] });
  expect(response.status).toBe(200);
  expect(fixture.live).toMatchObject({ perks: { 2: { hash: 2, editor: {} } } });
});
