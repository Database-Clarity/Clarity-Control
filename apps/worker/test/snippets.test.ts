/// <reference types="vite/client" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { SettingsDatabase, SettingsStatement } from '../src/settings.js';
import { Fixture, makePrivateKey } from './fixture.js';
import { snippetsPath } from '../../../packages/core/src/customSnippets.js';
import worker from '../src/index.js';
import { apiRequest } from '../../web/src/services/apiAuth';
import { getPersonalSnippet, savePersonalSnippet } from '../../web/src/services/snippets';
vi.mock('../../web/src/services/apiAuth', () => ({
  apiRequest: vi.fn(),
  failure: async (response: Response) => {
    throw new Error(await response.text());
  },
}));

let key: string;
let fixture: Fixture;
let db: DatabaseSync;
let beforeWrite: (() => Promise<void>) | undefined;
const binding: SettingsDatabase = {
  prepare(sql) {
    let values: (string | number | null)[] = [];
    const stmt: SettingsStatement = {
      bind(...args) {
        values = args;
        return stmt;
      },
      async first<T>() {
        return (db.prepare(sql).get(...values) ?? null) as T | null;
      },
      async run() {
        const hook = beforeWrite;
        beforeWrite = undefined;
        await hook?.();
        return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
      },
    };
    return stmt;
  },
};
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_user_settings.sql',
    '0002_user_worklists.sql',
    '0003_user_snippets.sql',
  ])
    db.exec(readFileSync(new URL(`../migrations/settings/${migration}`, import.meta.url), 'utf8'));
  fixture.env.SETTINGS_DB = binding;
  beforeWrite = undefined;
  vi.mocked(apiRequest).mockImplementation((path, init) =>
    fixture.request(
      path,
      init?.method ?? 'GET',
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});
const snippet = {
  id: 'me:one',
  label: 'My bonus',
  template: 'Gain {{1:10}} damage.',
  keywords: 'bonus',
};
const team = { ...snippet, id: 'team:one' };
const put = (next: unknown = snippet, revision: string | null = null, user = 1, id = snippet.id) =>
  fixture.request(`/snippets/mine/${id}`, 'PUT', { snippet: next, revision }, user);
const saveTeam = (next: unknown = team, base: unknown = null, user = 1, id = team.id) =>
  fixture.request('/snippets/team', 'PUT', { id, base, next }, user);
async function ok(response: Response) {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value;
}
it('takes the real client URLs through the Worker for personal CRUD', async () => {
  const saved = await savePersonalSnippet(snippet.id, snippet, null);
  expect(await getPersonalSnippet(snippet.id)).toEqual(saved);
  expect(await savePersonalSnippet(snippet.id, null, saved.revision)).toEqual({
    snippet: null,
    revision: null,
  });
});
it('enforces case-insensitive labels atomically per source, while allowing the same label across sources', async () => {
  const saved = await ok(await put());
  const duplicate = { ...snippet, id: 'me:second', label: 'MY BONUS' };
  expect((await put(duplicate, null, 1, duplicate.id)).status).toBe(400);
  const other = await ok(await put({ ...duplicate, label: 'Other' }, null, 1, duplicate.id));
  expect((await put(duplicate, other.revision, 1, duplicate.id)).status).toBe(400);
  expect((await put({ ...snippet, label: 'MY BONUS' }, saved.revision)).status).toBe(200);
  await ok(await put(snippet, null, 2));
  await ok(await saveTeam());
  expect(
    (await saveTeam({ ...team, id: 'team:second', label: 'MY BONUS' }, null, 1, 'team:second'))
      .status,
  ).toBe(400);
  beforeWrite = async () => {
    await ok(await put({ ...snippet, id: 'me:winner', label: 'Concurrent' }, null, 1, 'me:winner'));
  };
  expect(
    (await put({ ...snippet, id: 'me:loser', label: 'CONCURRENT' }, null, 1, 'me:loser')).status,
  ).toBe(400);
});
it('isolates encrypted personal CRUD for all four editor roles, and denies outsiders', async () => {
  for (const user of [1, 2, 3, 4]) {
    expect(await ok(await fixture.request('/snippets/mine', 'GET', undefined, user))).toEqual({
      snippets: [],
    });
    const saved = await ok(await put(snippet, null, user));
    expect(saved.snippet).toEqual(snippet);
    expect(
      await ok(await fixture.request('/snippets/mine/me:one', 'GET', undefined, user)),
    ).toEqual(saved);
    expect(
      (await ok(await fixture.request('/snippets/mine', 'GET', undefined, user))).snippets,
    ).toEqual([saved]);
    const edited = await ok(await put({ ...snippet, label: 'Changed' }, saved.revision, user));
    await ok(await put(null, edited.revision, user));
  }
  for (const user of [5, 99]) expect((await put(snippet, null, user)).status).toBe(403);
  await ok(await put());
  expect(await ok(await fixture.request('/snippets/mine/me:one', 'GET', undefined, 2))).toEqual({
    snippet: null,
    revision: null,
  });
  const row = db.prepare('SELECT * FROM user_snippets').get()!;
  expect(String(row.account_id)).toMatch(/^[a-f0-9]{64}$/);
  expect(String(row.ct)).not.toContain('damage');
  expect(fixture.commits).toHaveLength(0);
});
it.each([false, true])('preserves a competing personal write (existing: %s)', async (existing) => {
  const revision = existing ? (await ok(await put())).revision : null;
  let winner: unknown;
  beforeWrite = async () => {
    winner = await ok(await put({ ...snippet, label: 'Winner' }, revision));
  };
  const result = await put({ ...snippet, label: 'Loser' }, revision);
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject(winner!);
});
it('rejects invalid writes, enforces the atomic cap, and authenticates ciphertext against account/id/revision', async () => {
  for (const value of [
    { ...snippet, label: 'Link' },
    { ...snippet, label: 'x'.repeat(41) },
    { ...snippet, template: '<bad/>' },
    { ...snippet, template: 'x'.repeat(2001) },
    { ...snippet, template: '#plain' },
    { ...snippet, extra: true },
  ])
    expect((await put(value)).status).toBe(400);
  for (let n = 0; n < 49; n++)
    await ok(await put({ ...snippet, id: `me:${n}`, label: `Bonus ${n}` }, null, 1, `me:${n}`));
  beforeWrite = async () => {
    await ok(await put({ ...snippet, id: 'me:winner', label: 'Winner' }, null, 1, 'me:winner'));
  };
  expect((await put()).status).toBe(400);
  const saved = await ok(await fixture.request('/snippets/mine/me:0', 'GET'));
  await ok(await put({ ...snippet, id: 'me:0', label: 'At cap' }, saved.revision, 1, 'me:0'));
  db.prepare('UPDATE user_snippets SET revision = ? WHERE id = ?').run('b'.repeat(32), 'me:0');
  expect((await fixture.request('/snippets/mine/me:0', 'GET')).status).toBe(503);
});
it('allows all editor roles to read team snippets, but only maintainers write and copy', async () => {
  for (const user of [1, 2, 3, 4])
    expect((await fixture.request('/snippets/team', 'GET', undefined, user)).status).toBe(200);
  for (const user of [2, 3, 4, 99]) {
    expect((await saveTeam(team, null, user)).status).toBe(403);
    expect((await fixture.request('/snippets/team/copy', 'POST', {}, user)).status).toBe(403);
  }
  const personal = await ok(await put());
  await ok(
    await fixture.request('/snippets/team/copy', 'POST', {
      sourceId: snippet.id,
      sourceRevision: personal.revision,
      id: team.id,
      base: null,
    }),
  );
  expect((await ok(await fixture.request('/snippets/team', 'GET'))).team.snippets).toEqual([team]);
  expect((await saveTeam({ ...team, label: 'Stale' })).status).toBe(409);
  await ok(await saveTeam({ ...team, label: 'Updated' }, team));
  await ok(await saveTeam(null, { ...team, label: 'Updated' }));
});
it('enforces the team cap, ids, and validation', async () => {
  expect((await saveTeam({ ...team, template: '<oops>' })).status).toBe(400);
  expect((await saveTeam({ ...team, id: 'me:one' })).status).toBe(400);
  fixture.moveData({
    [snippetsPath]: {
      v: 1,
      snippets: Array.from({ length: 100 }, (_, n) => ({
        ...team,
        id: `team:${n}`,
        label: `Bonus ${n}`,
      })),
    },
  });
  expect((await saveTeam()).status).toBe(400);
  await ok(
    await saveTeam(
      { ...team, id: 'team:0', label: 'Edited' },
      { ...team, id: 'team:0', label: 'Bonus 0' },
      1,
      'team:0',
    ),
  );
});
it('denies anonymous and partner-only accounts', async () => {
  fixture.moveData({
    'config/permissions.json': {
      users: {},
      partners: { '5': { login: 'partner', projects: ['project'] } },
    },
  });
  for (const path of ['/snippets/mine', '/snippets/mine/me:one', '/snippets/team']) {
    expect((await fixture.request(path, 'GET', undefined, 5)).status).toBe(403);
    const response = await worker.fetch(
      new Request(`https://api.example${path}`, { headers: { Origin: fixture.env.SITE_ORIGIN } }),
      fixture.env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(401);
  }
});
it('rejects ciphertext moved between accounts or ids', async () => {
  await ok(await put());
  await ok(await put({ ...snippet, id: 'me:other', label: 'Other' }, null, 1, 'me:other'));
  await ok(await put(snippet, null, 2));
  const rows = db.prepare('SELECT * FROM user_snippets ORDER BY account_id, id').all();
  const target = rows[0];
  for (const row of rows.slice(1))
    db.prepare(
      'UPDATE user_snippets SET iv = ?, ct = ?, revision = ? WHERE account_id = ? AND id = ?',
    ).run(target.iv, target.ct, target.revision, row.account_id, row.id);
  const results = await Promise.all([
    fixture.request('/snippets/mine', 'GET'),
    fixture.request('/snippets/mine', 'GET', undefined, 2),
  ]);
  expect(results.some((r) => r.status === 503)).toBe(true);
});
it('retries unrelated team changes, refuses same-entry races, and rechecks revoked permissions', async () => {
  const other = { ...team, id: 'team:other', label: 'Other' };
  fixture.beforePatch = () => fixture.moveData({ [snippetsPath]: { v: 1, snippets: [other] } });
  expect((await ok(await saveTeam())).team.snippets).toEqual([other, team]);
  fixture.beforePatch = () =>
    fixture.moveData({ [snippetsPath]: { v: 1, snippets: [{ ...team, label: 'Winner' }, other] } });
  expect((await saveTeam({ ...team, label: 'Loser' }, team)).status).toBe(409);
  fixture.beforePatch = () =>
    fixture.moveData({
      'config/permissions.json': { users: { '1': { login: 'alice', role: 'trial' } } },
    });
  expect(
    (await saveTeam({ ...team, label: 'After revoke' }, { ...team, label: 'Winner' })).status,
  ).toBe(403);
});
