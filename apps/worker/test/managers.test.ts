import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsSchema, type Permissions, type Tooltip } from '@clarity/core';
import { config, Fixture, makePrivateKey, sha } from './fixture.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));

/**
 * Translation managers (PRODUCT "Translation managers"): every role x action x language case of
 * the translators routes and upload rollback, on fixture history.
 */
let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// 5 manages de (and translates de, fr); 6 manages fr; 7 translates de and fr; 8 translates fr.
const team: Permissions = {
  users: {
    ...config.users,
    '5': { login: 'erin', role: 'translator', languages: ['de', 'fr'], manages: ['de'] },
    '6': { login: 'finn', role: 'translator', languages: ['fr'], manages: ['fr'] },
    '7': { login: 'gail', role: 'translator', languages: ['de', 'fr'] },
    '8': { login: 'hana', role: 'translator', languages: ['fr'] },
  },
  partners: { '9': { login: 'ivy', projects: ['dim'] } },
};
const logins: Record<number, string> = {
  1: 'alice',
  2: 'bob',
  3: 'carol',
  4: 'dan',
  5: 'erin',
  6: 'finn',
  7: 'gail',
  8: 'hana',
};
const as = (id: number, path: string, method = 'GET', value?: unknown) =>
  fixture.request(path, method, value, id, logins[id]);
const stored = () => permissionsSchema.parse(fixture.current()['config/permissions.json']);

beforeEach(() => {
  fixture = new Fixture(key);
  fixture.moveData({ 'config/permissions.json': team });
  fixture.accounts = {
    newbie: { id: 20, login: 'Newbie', type: 'User' },
    hana: { id: 8, login: 'hana', type: 'User' },
    gail: { id: 7, login: 'gail', type: 'User' },
    dan: { id: 4, login: 'dan', type: 'User' },
    bob: { id: 2, login: 'bob', type: 'User' },
    alice: { id: 1, login: 'alice', type: 'User' },
    carol: { id: 3, login: 'carol', type: 'User' },
    finn: { id: 6, login: 'finn', type: 'User' },
    erin: { id: 5, login: 'erin', type: 'User' },
    ivy: { id: 9, login: 'ivy', type: 'User' },
    org: { id: 30, login: 'org', type: 'Organization' },
  };
});

describe('permissions file', () => {
  it.each([
    ['an editor', { login: 'x', role: 'editor', manages: ['de'] }],
    ['English', { login: 'x', role: 'translator', languages: ['en', 'de'], manages: ['en'] }],
    [
      'an unassigned language',
      { login: 'x', role: 'translator', languages: ['de'], manages: ['fr'] },
    ],
    ['an empty list', { login: 'x', role: 'translator', languages: ['de'], manages: [] }],
  ])('refuses managing %s', (_, access) => {
    expect(permissionsSchema.safeParse({ users: { '1': access } }).success).toBe(false);
  });

  it('maintainers assign and remove managers', async () => {
    const read = await (await as(1, '/permissions')).json();
    const users = { ...read.permissions.users, '7': { ...team.users['7'], manages: ['fr'] } };
    const put = await as(1, '/permissions', 'PUT', {
      revision: read.revision,
      permissions: { ...read.permissions, users },
    });
    expect(put.status).toBe(200);
    expect(stored().users['7']!.manages).toEqual(['fr']);
  });

  it.each([5, 2, 4])('user %i cannot change permissions or elevate themselves', async (id) => {
    expect((await as(id, '/permissions')).status).toBe(403);
    const read = await (await as(1, '/permissions')).json();
    const users = { ...read.permissions.users, [id]: { login: logins[id], role: 'maintainer' } };
    const put = await as(id, '/permissions', 'PUT', {
      revision: read.revision,
      permissions: { ...read.permissions, users },
    });
    expect(put.status).toBe(403);
    expect(stored()).toEqual(team);
  });

  it('/me reports managed languages', async () => {
    expect((await (await as(5, '/me')).json()).manages).toEqual(['de']);
    expect((await (await as(7, '/me')).json()).manages).toBeUndefined();
    expect((await (await as(1, '/me')).json()).manages).toBeUndefined();
  });
});

describe('translators routes', () => {
  it('lists the translators of a managed language', async () => {
    const response = await as(5, '/translators/de');
    expect(response.status).toBe(200);
    expect((await response.json()).translators.map((t: { login: string }) => t.login)).toEqual([
      'dan',
      'erin',
      'gail',
    ]);
  });

  it.each([
    ['a manager, another language', 5, 'fr'],
    ['a manager, English', 5, 'en'],
    ['a translator', 7, 'de'],
    ['an editor', 2, 'de'],
    ['a trial', 3, 'de'],
    ['a maintainer', 1, 'de'],
  ])('refuses %s every action', async (_, id, lang) => {
    const status = lang === 'en' ? 400 : 403;
    expect((await as(id, `/translators/${lang}`)).status).toBe(status);
    expect((await as(id, `/translators/${lang}`, 'POST', { login: 'newbie' })).status).toBe(status);
    expect((await as(id, `/translators/${lang}/8`, 'DELETE')).status).toBe(status);
    expect(stored()).toEqual(team);
    expect(fixture.commits).toHaveLength(0);
  });

  it('adds a new account as a translator, authored by the manager', async () => {
    const response = await as(5, '/translators/de', 'POST', { login: 'newbie' });
    expect(response.status).toBe(200);
    expect(stored().users['20']).toEqual({
      login: 'Newbie',
      role: 'translator',
      languages: ['de'],
    });
    const commit = fixture.commits[0]!;
    expect(commit.message).toBe('Add Newbie as de translator by erin');
    expect(commit.author).toEqual(expect.objectContaining({ name: 'erin' }));
    expect(commit.committer).toEqual(expect.objectContaining({ name: 'clarity-test[bot]' }));
  });

  it('adds the language to an existing translator and keeps the others', async () => {
    expect((await as(5, '/translators/de', 'POST', { login: 'hana' })).status).toBe(200);
    expect(stored().users['8']).toEqual({
      login: 'hana',
      role: 'translator',
      languages: ['fr', 'de'],
    });
  });

  it('adding a current translator writes nothing', async () => {
    expect((await as(5, '/translators/de', 'POST', { login: 'gail' })).status).toBe(200);
    expect(fixture.commits).toHaveLength(0);
  });

  it.each([
    ['a maintainer', 'alice'],
    ['an editor', 'bob'],
    ['a trial', 'carol'],
    ['another manager', 'finn'],
    ['an export partner', 'ivy'],
    ['themselves', 'erin'],
  ])('refuses adding %s', async (_, login) => {
    expect((await as(5, '/translators/de', 'POST', { login })).status).toBe(403);
    expect(stored()).toEqual(team);
  });

  it('refuses organisations and unknown accounts', async () => {
    expect((await as(5, '/translators/de', 'POST', { login: 'org' })).status).toBe(400);
    expect((await as(5, '/translators/de', 'POST', { login: 'ghost' })).status).toBe(404);
    expect(stored()).toEqual(team);
  });

  it('removes only the managed language', async () => {
    expect((await as(5, '/translators/de/7', 'DELETE')).status).toBe(200);
    expect(stored().users['7']).toEqual({ login: 'gail', role: 'translator', languages: ['fr'] });
    expect(fixture.commits[0]!.message).toBe('Remove gail as de translator by erin');
  });

  it("removing a translator's last language removes the account", async () => {
    expect((await as(5, '/translators/de/4', 'DELETE')).status).toBe(200);
    expect(stored().users['4']).toBeUndefined();
  });

  it.each([
    ['a translator of another language', 8, 404],
    ['a manager', 6, 403],
    ['themselves', 5, 403],
    ['a maintainer', 1, 403],
    ['an editor', 2, 403],
    ['a trial', 3, 403],
    ['an unknown account', 99, 404],
  ])('refuses removing %s', async (_, id, status) => {
    expect((await as(5, `/translators/de/${id}`, 'DELETE')).status).toBe(status);
    expect(stored()).toEqual(team);
  });

  it('re-checks the manager role at a moved head', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({
        'config/permissions.json': {
          ...team,
          users: { ...team.users, '5': { ...team.users['5']!, manages: undefined } },
        },
      });
    expect((await as(5, '/translators/de', 'POST', { login: 'newbie' })).status).toBe(403);
    expect(stored().users['20']).toBeUndefined();
  });
});

describe('upload rollback', () => {
  const entry = (text: string, at: string, by: string, source?: string) => ({
    text,
    updatedAt: at,
    updatedBy: by,
    ...(source ? { sourceUpdatedAt: source } : {}),
  });
  const perk = (hash: number, text: Partial<Tooltip['text']>): Tooltip => ({
    hash,
    text: { en: entry(`English ${hash}`, '2026-10-05T00:00:00Z', 'alice'), ...text },
    associated: [],
  });
  let parent: string;
  let upload: string;

  // 123: the upload changed de and fr; 124: the upload changed de, a later save changed it again;
  // 125: the upload added de (rollback removes it); 126: legacy de without a source.
  beforeEach(() => {
    fixture.moveData({
      'tooltips/123.json': perk(123, {
        de: entry('Alt 123', '2026-10-02T00:00:00Z', 'dan', '2026-10-01T00:00:00Z'),
        fr: entry('Vieux 123', '2026-10-02T00:00:00Z', 'hana', '2026-10-01T00:00:00Z'),
      }),
      'tooltips/124.json': perk(124, {
        de: entry('Alt 124', '2026-10-02T00:00:00Z', 'dan', '2026-10-01T00:00:00Z'),
      }),
      'tooltips/125.json': perk(125, {}),
      'tooltips/126.json': perk(126, { de: entry('Legacy 126', '2026-09-01T00:00:00Z', 'dan') }),
    });
    parent = fixture.dataHead;
    fixture.moveData(
      {
        'tooltips/123.json': perk(123, {
          de: entry('Neu 123', '2026-10-06T00:00:00Z', 'gail', '2026-10-05T00:00:00Z'),
          fr: entry('Nouveau 123', '2026-10-06T00:00:00Z', 'gail', '2026-10-05T00:00:00Z'),
        }),
        'tooltips/124.json': perk(124, {
          de: entry('Neu 124', '2026-10-06T00:00:00Z', 'gail', '2026-10-05T00:00:00Z'),
        }),
        'tooltips/125.json': perk(125, {
          de: entry('Neu 125', '2026-10-06T00:00:00Z', 'gail', '2026-10-05T00:00:00Z'),
        }),
        'tooltips/126.json': perk(126, {
          de: entry('Neu 126', '2026-10-06T00:00:00Z', 'gail', '2026-10-05T00:00:00Z'),
        }),
      },
      'Translate\n\nClarity-Changed: 123=de,fr;124=de;125=de;126=de',
    );
    upload = fixture.dataHead;
    fixture.moveData(
      {
        'tooltips/124.json': perk(124, {
          de: entry('Später 124', '2026-10-07T00:00:00Z', 'dan', '2026-10-05T00:00:00Z'),
        }),
      },
      'Later\n\nClarity-Changed: 124=de',
    );
  });
  const plan = (id: number, lang = 'de', commit = upload) =>
    as(id, `/rollback/upload?commit=${commit}&lang=${lang}`);
  const apply = (id: number, lang = 'de', commit = upload) =>
    as(id, '/rollback/upload', 'POST', { commit, lang });
  const head = (hash: number) => fixture.current()[`tooltips/${hash}.json`] as Tooltip;

  it('previews what reverts and what a later save already changed', async () => {
    const response = await plan(5);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      upload,
      lang: 'de',
      reverted: [123, 125, 126],
      skipped: [{ hash: 124, reason: 'changed-later' }],
    });
    expect(fixture.commits).toHaveLength(0);
  });

  it("reverts only the manager's language as a new save by the manager", async () => {
    const before = fixture.dataHead;
    const response = await apply(5);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toEqual([{ hash: 124, reason: 'changed-later' }]);
    expect(body.upload).toBe(upload);
    expect(body.commit).toBe(fixture.dataHead);
    expect(body.tooltips.map((t: Tooltip) => t.hash)).toEqual([123, 125, 126]);
    const commit = fixture.commits[0]!;
    expect(commit.parents).toEqual([before]);
    expect(String(commit.message)).toMatch(/^Roll back de of upload [0-9a-f]{8} by erin\n/);
    expect(commit.author).toEqual(expect.objectContaining({ name: 'erin' }));
    expect(commit.committer).toEqual(expect.objectContaining({ name: 'clarity-test[bot]' }));
    // Old text, revised now by the manager, still translating the English it was written for.
    expect(head(123).text.de).toEqual({
      text: 'Alt 123',
      updatedAt: expect.stringMatching(/^20/),
      updatedBy: 'erin',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    });
    expect(Date.parse(head(123).text.de!.updatedAt)).toBeGreaterThan(Date.parse('2026-10-07'));
    // English and other languages are untouched; the later-edited perk is skipped.
    expect(head(123).text.fr!.text).toBe('Nouveau 123');
    expect(head(123).text.en).toEqual(perk(123, {}).text.en);
    expect(head(124).text.de!.text).toBe('Später 124');
    expect(head(125).text.de).toBeUndefined();
    // A legacy entry without a source keeps that revision's English as its source.
    expect(head(126).text.de).toEqual(
      expect.objectContaining({ text: 'Legacy 126', sourceUpdatedAt: '2026-10-05T00:00:00Z' }),
    );
  });

  it('keeps every state in history', async () => {
    await apply(5);
    const version = await (await as(5, `/history/123?commit=${upload}`)).json();
    expect(version.tooltip.text.de.text).toBe('Neu 123');
    const older = await (await as(5, `/history/123?commit=${parent}`)).json();
    expect(older.tooltip.text.de.text).toBe('Alt 123');
  });

  it('maintainers roll back any translation language', async () => {
    expect((await apply(1, 'fr')).status).toBe(200);
    expect(head(123).text.fr!.text).toBe('Vieux 123');
    expect(head(123).text.de!.text).toBe('Neu 123');
  });

  it.each([
    ['a manager, another language', 5, 'fr', 403],
    ['a manager, English', 5, 'en', 400],
    ['a maintainer, English', 1, 'en', 400],
    ['a translator', 7, 'de', 403],
    ['an editor', 2, 'de', 403],
    ['a trial', 3, 'de', 403],
  ])('refuses %s', async (_, id, lang, status) => {
    expect((await plan(id, lang)).status).toBe(status);
    expect((await apply(id, lang)).status).toBe(status);
    expect(fixture.commits).toHaveLength(0);
  });

  it('refuses commits that are not uploads or not in the data history', async () => {
    fixture.moveData({}, 'Publish batch');
    const system = fixture.dataHead;
    expect((await apply(5, 'de', system)).status).toBe(422);
    fixture.snapshots.set(sha(999), fixture.current());
    expect((await apply(5, 'de', sha(999))).status).toBe(422);
    expect((await apply(5, 'de', sha(998))).status).toBe(404);
    expect(fixture.commits).toHaveLength(0);
  });

  it('answers 409 when nothing is left to roll back', async () => {
    await apply(5);
    const response = await apply(5);
    expect(response.status).toBe(409);
    expect(fixture.commits).toHaveLength(1);
  });

  it('re-checks the manager role at the save head', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({
        'config/permissions.json': {
          ...team,
          users: { ...team.users, '5': { ...team.users['5']!, manages: undefined } },
        },
      });
    expect((await apply(5)).status).toBe(403);
    expect(head(123).text.de!.text).toBe('Neu 123');
  });
});
