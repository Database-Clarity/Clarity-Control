import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Permissions, type Tooltip } from '@clarity/core';
import { config, Fixture, makePrivateKey, tooltip } from './fixture.js';

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
const change = (base = tooltip(), next = tooltip('mine')) => ({
  changes: [{ hash: 123, base, next }],
  message: 'Edit tooltip',
});

describe('save permission matrix', () => {
  it('rejects stale alias drafts and creates with a clear canonical target and no writes', async () => {
    fixture.aliases[123] = { to: 456, kind: 'frame' };
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'Tooltip 123 is an alias; edit canonical tooltip 456',
    });
    const created = await fixture.request('/save', 'POST', {
      changes: [{ hash: 123, base: null, next: tooltip('new alias') }],
      message: 'Create',
    });
    expect(created.status).toBe(422);
    expect(fixture.commits).toHaveLength(0);
  });
  it.each([1, 2, 3])('allows role id %s and credits the editor, not the bot', async (id) => {
    const response = await fixture.request('/save', 'POST', change(), id);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ commit: fixture.dataHead, tooltips: [tooltip('mine')] });
    expect(fixture.commits[0]).toMatchObject({
      author: {
        name: config.users[String(id)].login,
        email: `${id}+${config.users[String(id)].login}@users.noreply.github.com`,
      },
      committer: { name: 'clarity-test[bot]', email: 'clarity-test[bot]@users.noreply.github.com' },
    });
  });

  it('denies unknown identities', async () => {
    expect((await fixture.request('/save', 'POST', change(), 5)).status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
  });

  it('allows translators to change only their assigned language', async () => {
    const next = tooltip();
    next.text.de = { text: 'Deutsch', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'dan' };
    expect((await fixture.request('/save', 'POST', change(tooltip(), next), 4)).status).toBe(200);
  });

  it('rejects the translator null-base creation repro without writing', async () => {
    const response = await fixture.request(
      '/save',
      'POST',
      {
        message: 'Create',
        changes: [
          {
            hash: 125,
            base: null,
            next: {
              hash: 125,
              text: {
                de: { text: 'Deutsch', updatedAt: '2026-11-03T00:00:00Z', updatedBy: 'dan' },
              },
              associated: [],
            },
          },
        ],
      },
      4,
    );
    expect(response.status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
  });

  it.each(['en', 'fr', 'associated', 'compendium', 'legacy', 'custom'])(
    'rejects translator changes to %s',
    async (field) => {
      const next = tooltip();
      if (field === 'en' || field === 'fr') {
        next.text[field] = {
          text: 'forbidden',
          updatedAt: '2026-10-02T00:00:00Z',
          updatedBy: 'dan',
        };
      } else if (field === 'associated') next.associated = [999];
      else if (field === 'compendium')
        next.compendium = {
          gid: '1662574278',
          rowKey: 'Demo',
          snapshot: { plain: '', runs: [] },
          snapshotAt: '2026-10-02T00:00:00Z',
        };
      else if (field === 'legacy') next.legacy = { uploadedBy: 'spoofed' };
      else next.custom = { name: 'custom', categoryId: 'none' };
      expect((await fixture.request('/save', 'POST', change(tooltip(), next), 4)).status).toBe(403);
      expect(fixture.commits).toHaveLength(0);
    },
  );

  it('preserves unowned head fields even when a translator forges the base', async () => {
    const base = tooltip('forged English');
    const next = structuredClone(base);
    next.text.de = { text: 'Deutsch', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'dan' };
    const response = await fixture.request('/save', 'POST', change(base, next), 4);
    expect(response.status).toBe(200);
    expect(fixture.current()['tooltips/123.json']).toMatchObject({
      text: { en: { text: 'original' }, de: { text: 'Deutsch' } },
    });
  });
});

describe('save concurrency', () => {
  it('merges different languages and association sets', async () => {
    const base = tooltip();
    const head = tooltip();
    head.text.fr = { text: 'bonjour', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'bob' };
    head.associated = [77];
    fixture.moveData({ 'tooltips/123.json': head });
    const next = tooltip('mine');
    next.associated = [88];
    const response = await fixture.request('/save', 'POST', change(base, next));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0]).toMatchObject({
      associated: [88, 77],
      text: { en: { text: 'mine' }, fr: { text: 'bonjour' } },
    });
  });

  it('returns all conflicts and writes nothing, including other tooltips', async () => {
    fixture.moveData({ 'tooltips/123.json': tooltip('theirs') });
    const request = change();
    request.changes.push({
      hash: 124,
      base: { ...tooltip(), hash: 124 },
      next: { ...tooltip('other'), hash: 124 },
    });
    const response = await fixture.request('/save', 'POST', request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      conflicts: [
        {
          hash: 123,
          base: tooltip(),
          head: tooltip('theirs'),
          next: tooltip('mine'),
          fields: ['text.en'],
        },
        {
          hash: 124,
          base: { ...tooltip(), hash: 124 },
          head: null,
          next: { ...tooltip('other'), hash: 124 },
          fields: ['$exists'],
        },
      ],
    });
    expect(fixture.commits).toHaveLength(0);
  });

  it('restarts from head and merges after a non-fast-forward race', async () => {
    fixture.beforePatch = () => {
      const head = tooltip();
      head.text.de = { text: 'parallel edit', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'dan' };
      fixture.moveData({ 'tooltips/123.json': head });
    };
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(200);
    expect(fixture.commits).toHaveLength(2);
    expect(fixture.current()['tooltips/123.json']).toMatchObject({
      text: { en: { text: 'mine' }, de: { text: 'parallel edit' } },
    });
  });

  it('rechecks revoked permissions on a ref race', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({
        'config/permissions.json': {
          users: { '1': { login: 'alice', role: 'maintainer' } },
        } satisfies Permissions,
      });

    const response = await fixture.request('/save', 'POST', change(), 2);
    expect(response.status).toBe(403);
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip());
  });

  it('bounds ref-update retries without claiming a successful save', async () => {
    fixture.patchRaces = 3;
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Data branch kept moving; reload and retry your save',
    });
    expect(fixture.commits).toHaveLength(3);
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip());
  });

  it('creates new tooltips with null base and rejects duplicate changes or hash mismatches', async () => {
    const input = {
      changes: [{ hash: 125, base: null, next: { ...tooltip(), hash: 125 } }],
      message: 'Create',
    };
    expect((await fixture.request('/save', 'POST', input)).status).toBe(200);
    expect((await fixture.request('/save', 'POST', change())).status).toBe(200);
    const duplicate = change();
    duplicate.changes.push(duplicate.changes[0]);
    expect((await fixture.request('/save', 'POST', duplicate)).status).toBe(400);
    const mismatch = change();
    mismatch.changes[0].next.hash = 999;
    expect((await fixture.request('/save', 'POST', mismatch)).status).toBe(400);
  });

  it('returns a conflict when two users both create the same hash', async () => {
    const next: Tooltip = tooltip('new');
    const response = await fixture.request('/save', 'POST', {
      changes: [{ hash: 123, base: null, next }],
      message: 'Create',
    });
    expect(response.status).toBe(409);
    expect(fixture.commits).toHaveLength(0);
  });
});

describe('sandbox set-bonus creation follows existing armor permissions', () => {
  it.each([1, 2, 3, 4])('uses the existing role rule for user %s', async (id) => {
    const next: Tooltip = {
      ...tooltip('Set-bonus text'),
      hash: 3333333333,
      custom: { name: 'Example Set (2 pc): Bonus', categoryId: 'armor-set-bonus' },
    };
    const response = await fixture.request(
      '/save',
      'POST',
      {
        changes: [{ hash: next.hash, base: null, next }],
        message: 'Create set bonus',
      },
      id,
    );
    expect(response.status).toBe(id === 4 ? 403 : 200);
    expect(fixture.commits).toHaveLength(id === 4 ? 0 : 1);
  });
});
