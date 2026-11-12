// G-AUTH (export spec sections 4, 5, and 9): partner role, /exports routes, CAS races, cooldown,
// URL ownership, retained entries, path safety, and permissions back-compat.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permissions } from '@clarity/core';
import type { ExportConfig } from '@clarity/export/config';
import { planRetained, retainUntil } from '../src/exports.js';
import { blobOid, config, Fixture, makePrivateKey } from './fixture.js';

const privateKey = await makePrivateKey();
const start = Date.parse('2026-11-11T12:00:00Z');
const MAINTAINER = 1,
  EDITOR = 2,
  TRIAL = 3,
  TRANSLATOR = 4,
  PARTNER = 5,
  OTHER_PARTNER = 6,
  NOBODY = 7;

const withPartners: Permissions = {
  ...config,
  partners: {
    '5': { login: 'eve', projects: ['dim'] },
    '6': { login: 'frank', projects: ['other'] },
  },
};
const dimConfig = (): ExportConfig => ({
  schema: 1,
  id: 'dim',
  name: 'Destiny Item Manager',
  files: [{ id: 'descriptions', uid: 'aaaaaaaaaaaaaaaa', formatVersion: 1, preset: 'dim' }],
});
const otherConfig = (): ExportConfig => ({
  schema: 1,
  id: 'other',
  name: 'Other',
  files: [{ id: 'main', uid: 'bbbbbbbbbbbbbbbb', formatVersion: 1, preset: 'clarity' }],
});

let fixture: Fixture;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  fixture = new Fixture(privateKey);
  fixture.moveData({
    'config/permissions.json': withPartners,
    'exports/projects/dim.json': dimConfig(),
    'exports/projects/other.json': otherConfig(),
  });
  // Seed commits are old: no cooldown applies to the first save.
  vi.setSystemTime(start + 3_600_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const later = (ms = 31_000) => vi.setSystemTime(Date.now() + ms);
const stored = (id = 'dim') =>
  fixture.current()[`exports/projects/${id}.json`] as ExportConfig | undefined;
const revisionOf = (id = 'dim') => blobOid(stored(id));
const permissionsNow = () => fixture.current()['config/permissions.json'] as Permissions;
async function put(id: string, next: ExportConfig, user = PARTNER, revision = revisionOf(id)) {
  return fixture.request(`/exports/projects/${id}`, 'PUT', { revision, config: next }, user);
}
async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}
/** A minimal style file (the engine's index is not imported: it carries an untyped .mjs). */
const styleFile = (id: string, categories: string[] = []) => ({
  id,
  formatVersion: 1 as const,
  preset: 'markdown' as const,
  shape: 'text' as const,
  data: {
    categories,
    sandboxPerks: [],
    frameAliases: false,
    languages: ['en' as const],
    keys: ['name' as const],
    bungieIdentical: false,
  },
  format: {
    symbols: { bold: { mode: 'replace' as const, before: '**', after: '**' } },
    titles: { mode: 'drop' as const },
    links: { mode: 'drop' as const },
    elementTags: false,
    spacer: 'keep' as const,
  },
});

describe('GET /exports/projects', () => {
  const row = (config: ExportConfig) => ({
    schema: 1,
    name: config.name,
    files: config.files.map(({ id, preset, formatVersion }) => ({ id, preset, formatVersion })),
    retained: 0,
  });
  const get = async (path: string, user: number) =>
    fixture.request(`/exports/projects${path}`, 'GET', undefined, user);

  it('lists every project for maintainers and only their own for partners', async () => {
    const all = await body(await get('', MAINTAINER));
    expect(all.partnersRevision).toBe(blobOid(withPartners));
    expect(all.projects).toEqual([
      {
        id: 'dim',
        revision: revisionOf('dim'),
        ...row(dimConfig()),
        partners: [{ id: 5, login: 'eve' }],
      },
      {
        id: 'other',
        revision: revisionOf('other'),
        ...row(otherConfig()),
        partners: [{ id: 6, login: 'frank' }],
      },
    ]);
    const own = await body(await get('', PARTNER));
    expect(own).not.toHaveProperty('partnersRevision');
    expect(own.projects).toEqual([{ id: 'dim', revision: revisionOf('dim'), ...row(dimConfig()) }]);
  });

  it('serves one full config by ?project= to a maintainer or a partner of it', async () => {
    expect(await body(await get('?project=dim', PARTNER))).toEqual({
      head: fixture.dataHead,
      id: 'dim',
      revision: revisionOf('dim'),
      config: dimConfig(),
    });
    expect(await body(await get('?project=dim', MAINTAINER))).toMatchObject({
      config: dimConfig(),
      partnersRevision: blobOid(withPartners),
      partners: [{ id: 5, login: 'eve' }],
    });
    for (const id of [EDITOR, TRIAL, TRANSLATOR, NOBODY, OTHER_PARTNER])
      expect((await get('?project=dim', id)).status).toBe(403);
    expect((await get('?project=other', PARTNER)).status).toBe(403);
    expect((await get('?project=nope', MAINTAINER)).status).toBe(404);
    for (const query of ['?project=..%2Fdim', '?project=index', '?project=Dim'])
      expect((await get(query, MAINTAINER)).status).toBe(404);
    for (const query of ['?project=dim&project=other', '?project=dim&x=1', '?all=1'])
      expect((await get(query, MAINTAINER)).status).toBe(400);
    fixture.moveData({ 'exports/projects/dim.json': { ...dimConfig(), files: 'x' } });
    expect((await get('?project=dim', PARTNER)).status).toBe(502);
  });

  it('refuses every other role and lists an invalid stored config without serving it', async () => {
    for (const id of [EDITOR, TRIAL, TRANSLATOR, NOBODY])
      expect((await get('', id)).status).toBe(403);
    fixture.moveData({
      'exports/projects/broken.json': { schema: 1, id: 'broken', files: 'x' },
      'exports/projects/not-a-project.txt': {},
      'exports/projects/Upper.json': dimConfig(),
    });
    const all = await body(await get('', MAINTAINER));
    expect((all.projects as { id: string }[]).map((project) => project.id)).toEqual([
      'broken',
      'dim',
      'other',
    ]);
    expect((all.projects as Record<string, unknown>[])[0]).toEqual({
      id: 'broken',
      revision: revisionOf('broken'),
      error: 'Stored config is invalid',
      partners: [],
    });
  });

  it('reads with one GraphQL subrequest plus the app token', async () => {
    for (const path of ['', '?project=dim']) {
      fixture.subrequests = 0;
      expect((await get(path, PARTNER)).status).toBe(200);
      expect(fixture.subrequests).toBe(2);
    }
  });
});

describe('POST /exports/projects', () => {
  const create = (value: unknown, user = MAINTAINER) =>
    fixture.request('/exports/projects', 'POST', { config: value }, user);

  it('creates a project with server-assigned uids, authored by the user, committed by the app', async () => {
    const response = await create({
      schema: 1,
      id: 'light-gg',
      name: 'light.gg',
      files: [
        { id: 'descriptions', formatVersion: 1, preset: 'lightGG' },
        styleFile('notes', ['perk']),
      ],
    });
    expect(response.status).toBe(201);
    const result = await body(response);
    const saved = stored('light-gg')!;
    expect(result.config).toEqual(saved);
    expect(result.revision).toBe(revisionOf('light-gg'));
    expect(saved.files.map((file) => file.uid)).toEqual([
      expect.stringMatching(/^[a-z2-7]{16}$/),
      expect.stringMatching(/^[a-z2-7]{16}$/),
    ]);
    const commit = fixture.commits.at(-1)!;
    expect(commit.author).toMatchObject({
      name: 'alice',
      email: '1+alice@users.noreply.github.com',
    });
    expect(commit.committer).toMatchObject({ name: 'clarity-test[bot]' });
    expect(commit.message).toBe('Create export project light-gg by alice');
  });

  it('is maintainer-only and refuses an existing id', async () => {
    const value = { schema: 1, id: 'new-one', name: 'New', files: [] };
    for (const id of [EDITOR, TRIAL, TRANSLATOR, PARTNER, NOBODY])
      expect((await create(value, id)).status).toBe(403);
    expect((await create({ ...value, id: 'dim' })).status).toBe(409);
    expect(stored('new-one')).toBeUndefined();
  });

  it('refuses traversal, reserved names, client uids, retained entries, and unknown categories', async () => {
    const base = { schema: 1, name: 'X', files: [] };
    for (const id of [
      '../dim',
      'dim/x',
      'index',
      'changelog',
      'api',
      'assets',
      'well-known',
      'v2',
      '_build',
      'Dim',
      'd',
    ])
      expect((await create({ ...base, id })).status).toBe(400);
    for (const fileId of ['../../x', 'v1', 'index', 'a/b'])
      expect(
        (
          await create({
            ...base,
            id: 'xx',
            files: [{ id: fileId, formatVersion: 1, preset: 'dim' }],
          })
        ).status,
      ).toBe(400);
    const uid = await create({
      ...base,
      id: 'xx',
      files: [{ id: 'f1', uid: 'aaaaaaaaaaaaaaaa', formatVersion: 1, preset: 'dim' }],
    });
    expect(uid.status).toBe(400);
    expect((await body(uid)).error).toContain('did not assign');
    const retained = await create({
      ...base,
      id: 'xx',
      retained: [
        {
          path: 'xx/v1/f1.json',
          uid: 'aaaaaaaaaaaaaaaa',
          formatVersion: 1,
          snapshot: { id: 'f1', formatVersion: 1, preset: 'dim' },
          until: '2027-01-01T00:00:00Z',
        },
      ],
    });
    expect(retained.status).toBe(400);
    const unknown = await create({ ...base, id: 'xx', files: [styleFile('f1', ['nope'])] });
    expect(unknown.status).toBe(400);
    expect((await body(unknown)).details).toEqual(['nope']);
    expect(Object.keys(fixture.current()).filter((path) => path.startsWith('exports/'))).toEqual([
      'exports/projects/dim.json',
      'exports/projects/other.json',
    ]);
  });

  it('stops at 40 projects', async () => {
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 38; index++)
      many[`exports/projects/p${index}x.json`] = { ...otherConfig(), id: `p${index}x` };
    fixture.moveData(many);
    const response = await create({ schema: 1, id: 'one-more', name: 'X', files: [] });
    expect(response.status).toBe(400);
    expect((await body(response)).error).toBe('At most 40 export projects');
  });
});

describe('PUT /exports/projects/:id', () => {
  it('lets a partner change files of their own project only', async () => {
    const next = { ...dimConfig(), files: [...dimConfig().files, styleFile('notes', ['perk'])] };
    const response = await put('dim', next);
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.revision).toBe(revisionOf());
    expect(stored()!.files[1]).toMatchObject({ id: 'notes', uid: expect.any(String) });
    expect(fixture.commits.at(-1)!.author).toMatchObject({ name: 'unknown' });
    expect(fixture.commits.at(-1)!.message).toBe('Update export project dim by unknown');
    for (const id of [EDITOR, TRIAL, TRANSLATOR, NOBODY, OTHER_PARTNER])
      expect((await put('dim', dimConfig(), id)).status).toBe(403);
    expect((await put('other', otherConfig(), PARTNER)).status).toBe(403);
  });

  it('keeps id, name, and retained server- or maintainer-owned', async () => {
    const renamed = await put('dim', { ...dimConfig(), name: 'Mine now' });
    expect(renamed.status).toBe(403);
    expect((await put('dim', { ...dimConfig(), id: 'other' })).status).toBe(400);
    const retained = await put('dim', {
      ...dimConfig(),
      retained: [
        {
          path: 'dim/v1/old.json',
          uid: 'cccccccccccccccc',
          formatVersion: 1,
          snapshot: { id: 'old', formatVersion: 1, preset: 'dim' },
          until: '2030-01-01T00:00:00Z',
        },
      ],
    });
    expect(retained.status).toBe(403);
    expect(stored()).toEqual(dimConfig());
    const maintainer = await put('dim', { ...dimConfig(), name: 'DIM' }, MAINTAINER);
    expect(maintainer.status).toBe(200);
    expect(stored()!.name).toBe('DIM');
  });

  it('migrates and validates on write and refuses unknown keys', async () => {
    expect((await put('dim', { ...dimConfig(), extra: 1 } as ExportConfig)).status).toBe(400);
    expect(
      (await put('dim', { ...dimConfig(), schema: 2 } as unknown as ExportConfig)).status,
    ).toBe(400);
    const tooMany = {
      ...dimConfig(),
      files: ['a1', 'a2', 'a3', 'a4'].map((id) => ({
        id,
        formatVersion: 1 as const,
        preset: 'dim' as const,
      })),
    };
    expect((await put('dim', tooMany)).status).toBe(400);
    const unknown = await put('dim', {
      ...dimConfig(),
      files: [...dimConfig().files, styleFile('x1', ['nope'])],
    });
    expect(unknown.status).toBe(400);
  });

  it('never re-checks categories already stored (a dropped category is a build notice)', async () => {
    fixture.moveData({
      'exports/projects/dim.json': {
        ...dimConfig(),
        files: [{ ...styleFile('notes', ['gone']), uid: 'dddddddddddddddd' }],
      },
    });
    later();
    const next = structuredClone(stored()!);
    (next.files[0] as { data: { languages: string[] } }).data.languages = ['en', 'de'];
    fixture.subrequests = 0;
    expect((await put('dim', next)).status).toBe(200);
    expect(fixture.subrequests).toBe(5); // token, read, tree, commit, ref: no category fetch
  });

  it('applies a 30 s cooldown per project and returns a no-op save without a commit', async () => {
    const files = [...dimConfig().files, styleFile('notes')];
    expect((await put('dim', { ...dimConfig(), files })).status).toBe(200);
    const again = { ...stored()!, files: stored()!.files.slice(0, 1) };
    const blocked = await put('dim', again);
    expect(blocked.status).toBe(429);
    expect((await body(blocked)).details).toEqual({ retryAfter: 30 });
    const commits = fixture.commits.length;
    const noop = await put('dim', stored()!);
    expect(noop.status).toBe(200);
    expect((await body(noop)).commit).toBeNull();
    expect(fixture.commits.length).toBe(commits);
    later(29_000);
    expect((await put('dim', again)).status).toBe(429);
    later(2_000);
    expect((await put('dim', again)).status).toBe(200);
  });

  it('refuses a stale revision and an unknown project', async () => {
    expect((await put('dim', dimConfig(), PARTNER, 'f'.repeat(40))).status).toBe(409);
    fixture.moveData({
      'config/permissions.json': {
        ...withPartners,
        partners: { '5': { login: 'eve', projects: ['dim', 'nope'] } },
      },
    });
    expect(
      (
        await fixture.request(
          '/exports/projects/nope',
          'PUT',
          { revision: 'f'.repeat(40), config: { ...dimConfig(), id: 'nope' } },
          PARTNER,
        )
      ).status,
    ).toBe(404);
    for (const raw of ['..%2Fdim', 'index', 'v1', 'DIM', '_build'])
      expect(
        (
          await fixture.request(
            `/exports/projects/${raw}`,
            'PUT',
            { revision: 'f'.repeat(40), config: dimConfig() },
            MAINTAINER,
          )
        ).status,
      ).toBe(404);
  });
});

describe('retained URLs and URL ownership', () => {
  const twoFiles = (): ExportConfig => ({
    ...dimConfig(),
    files: [
      ...dimConfig().files,
      { id: 'extra', uid: 'eeeeeeeeeeeeeeee', formatVersion: 1, preset: 'clarity' },
    ],
  });
  beforeEach(() => {
    fixture.moveData({ 'exports/projects/dim.json': twoFiles() });
    later();
  });

  it('retains a renamed file for 3 months and lets its uid switch back', async () => {
    const renamed = twoFiles();
    renamed.files[0]!.id = 'texts';
    expect((await put('dim', renamed)).status).toBe(200);
    const until = retainUntil(new Date());
    expect(until.slice(0, 10)).toBe('2027-02-11');
    expect(stored()!.retained).toEqual([
      {
        path: 'dim/v1/descriptions.json',
        uid: 'aaaaaaaaaaaaaaaa',
        formatVersion: 1,
        snapshot: dimConfig().files[0],
        until,
      },
    ]);
    later();
    // Back to the old name: the same uid takes its URL back and the entry goes.
    const back = { ...stored()!, files: twoFiles().files };
    expect((await put('dim', back)).status).toBe(200);
    // The URL it leaves (texts) is retained in turn; descriptions is active again.
    expect(stored()).toEqual({
      ...twoFiles(),
      retained: [
        {
          path: 'dim/v1/texts.json',
          uid: 'aaaaaaaaaaaaaaaa',
          formatVersion: 1,
          snapshot: { ...dimConfig().files[0], id: 'texts' },
          until: retainUntil(new Date()),
        },
      ],
    });
  });

  it('retains a removed file, refuses a takeover of its URL, and restores it only through a maintainer', async () => {
    expect((await put('dim', { ...dimConfig(), files: twoFiles().files.slice(1) })).status).toBe(
      200,
    );
    expect(stored()!.retained).toMatchObject([
      { path: 'dim/v1/descriptions.json', uid: 'aaaaaaaaaaaaaaaa' },
    ]);
    later();
    const recreate = {
      ...stored()!,
      files: [
        ...stored()!.files,
        { id: 'descriptions', formatVersion: 1 as const, preset: 'dim' as const },
      ],
    };
    const takeover = await put('dim', recreate);
    expect(takeover.status).toBe(400);
    expect((await body(takeover)).error).toBe(
      'The URL dim/v1/descriptions.json belongs to another file',
    );
    // The other file may not move onto it either.
    const moved = structuredClone(stored()!);
    moved.files[0]!.id = 'descriptions';
    expect((await put('dim', moved)).status).toBe(400);
    const restore = { ...stored()!, files: [...stored()!.files, dimConfig().files[0]!] };
    const partner = await put('dim', restore);
    expect(partner.status).toBe(403);
    expect((await body(partner)).error).toBe('Only a maintainer can restore file descriptions');
    const maintainer = await put('dim', restore, MAINTAINER);
    expect(maintainer.status).toBe(200);
    expect(stored()!.retained).toBeUndefined();
    expect(stored()!.files.map((file) => file.uid)).toEqual([
      'eeeeeeeeeeeeeeee',
      'aaaaaaaaaaaaaaaa',
    ]);
  });

  it('keeps at most 2 old URLs per file and lists their window ends', async () => {
    for (const id of ['second', 'third']) {
      const next = structuredClone(stored()!);
      next.files[0]!.id = id;
      expect((await put('dim', next)).status).toBe(200);
      later();
    }
    const next = structuredClone(stored()!);
    next.files[0]!.id = 'fourth';
    const refused = await put('dim', next);
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toBe(
      'File fourth can keep at most 2 old URLs (dim/v1/descriptions.json until 2027-02-11, dim/v1/second.json until 2027-02-11, dim/v1/third.json until 2027-02-11); a maintainer can delete one after its window ends',
    );
  });

  it('never shortens a window: maintainers delete an entry only after it ends', async () => {
    expect((await put('dim', { ...dimConfig(), files: twoFiles().files.slice(1) })).status).toBe(
      200,
    );
    later();
    const without = { ...stored()!, retained: [] };
    const early = await put('dim', without, MAINTAINER);
    expect(early.status).toBe(400);
    expect((await body(early)).error).toContain('keeps updating until 2027-02-11');
    vi.setSystemTime(Date.parse('2027-02-12T00:00:00Z'));
    expect((await put('dim', without, PARTNER)).status).toBe(403);
    expect((await put('dim', without, MAINTAINER)).status).toBe(200);
    expect(stored()!.retained).toBeUndefined();
  });

  it('plans a format switch and a switch back with the same rules (pure planner)', () => {
    const now = new Date('2026-11-11T13:00:00Z');
    const previous = dimConfig();
    const switched = structuredClone(previous);
    (switched.files[0] as { formatVersion: number }).formatVersion = 2;
    const plan = planRetained(previous, switched, now);
    expect(plan.problems).toEqual([]);
    expect(plan.retained).toEqual([
      {
        path: 'dim/v1/descriptions.json',
        uid: 'aaaaaaaaaaaaaaaa',
        formatVersion: 1,
        snapshot: previous.files[0],
        until: '2027-02-11T13:00:00.000Z',
      },
    ]);
    const back = planRetained(
      { ...switched, retained: plan.retained },
      { ...previous, retained: plan.retained },
      now,
    );
    expect(back.retained).toEqual([
      {
        path: 'dim/v2/descriptions.json',
        uid: 'aaaaaaaaaaaaaaaa',
        formatVersion: 2,
        snapshot: switched.files[0],
        until: '2027-02-11T13:00:00.000Z',
      },
    ]);
  });
});

describe('PUT /exports/projects/:id/partners and permissions back-compat', () => {
  const partnersRevision = () => blobOid(permissionsNow());
  const setPartners = (
    logins: string[],
    user = MAINTAINER,
    revision = partnersRevision(),
    id = 'dim',
  ) => fixture.request(`/exports/projects/${id}/partners`, 'PUT', { revision, logins }, user);

  it('resolves a new login to its numeric id once and keeps existing ids without a lookup', async () => {
    fixture.accounts = { grace: { id: 77, login: 'Grace', type: 'User' } };
    const response = await setPartners(['EVE', 'grace']);
    expect(response.status).toBe(200);
    expect(fixture.accountLookups).toBe(1);
    const result = await body(response);
    expect(result.partners).toEqual([
      { id: 5, login: 'eve' },
      { id: 77, login: 'Grace' },
    ]);
    expect(permissionsNow().partners).toEqual({
      '5': { login: 'eve', projects: ['dim'] },
      '6': { login: 'frank', projects: ['other'] },
      '77': { login: 'Grace', projects: ['dim'] },
    });
    expect(permissionsNow().users).toEqual(config.users);
    expect(result.partnersRevision).toBe(partnersRevision());
    expect(fixture.commits.at(-1)!.author).toMatchObject({ name: 'alice' });
    // Removing the last project drops the entry.
    expect((await setPartners(['grace'])).status).toBe(200);
    expect(permissionsNow().partners).toEqual({
      '6': { login: 'frank', projects: ['other'] },
      '77': { login: 'Grace', projects: ['dim'] },
    });
    expect(fixture.accountLookups).toBe(1);
  });

  it('is maintainer-only and refuses stale revisions, missing projects, organisations, and unknown logins', async () => {
    for (const id of [EDITOR, TRIAL, TRANSLATOR, PARTNER, NOBODY])
      expect((await setPartners(['eve'], id)).status).toBe(403);
    expect((await setPartners(['eve'], MAINTAINER, 'f'.repeat(40))).status).toBe(409);
    expect((await setPartners(['eve'], MAINTAINER, partnersRevision(), 'nope')).status).toBe(404);
    fixture.accounts = { acme: { id: 9, login: 'acme', type: 'Organization' } };
    expect((await setPartners(['acme'])).status).toBe(400);
    expect((await setPartners(['ghost'])).status).toBe(404);
    for (const logins of [
      ['a b'],
      ['https://github.com/x'],
      ['eve', 'EVE'],
      Array.from({ length: 11 }, (_, i) => `u${i}`),
    ])
      expect((await setPartners(logins)).status).toBe(400);
    expect(permissionsNow()).toEqual(withPartners);
  });

  it('/me reports partner, editor, and no role with and without the partners map', async () => {
    const me = async (id: number) => body(await fixture.request('/me', 'GET', undefined, id));
    expect(await me(PARTNER)).toEqual({
      id: 5,
      login: 'unknown',
      role: 'partner',
      languages: [],
      projects: ['dim'],
    });
    expect(await me(EDITOR)).toEqual({ id: 2, login: 'bob', role: 'editor', languages: [] });
    expect(await me(NOBODY)).toEqual({ id: 7, login: 'unknown', role: null, languages: [] });
    fixture.moveData({
      'config/permissions.json': {
        ...withPartners,
        partners: { '2': { login: 'bob', projects: ['dim'] } },
      },
    });
    // An editor who is also a partner keeps the editor role; the projects are listed.
    expect(await me(EDITOR)).toEqual({
      id: 2,
      login: 'bob',
      role: 'editor',
      languages: [],
      projects: ['dim'],
    });
    fixture.moveData({ 'config/permissions.json': config });
    expect(await me(PARTNER)).toEqual({ id: 5, login: 'unknown', role: null, languages: [] });
    expect(await me(MAINTAINER)).toMatchObject({ role: 'maintainer' });
  });

  it('PUT /permissions keeps partners and refuses a client that drops or edits them', async () => {
    const loaded = await body(await fixture.request('/permissions', 'GET', undefined, MAINTAINER));
    expect(loaded.permissions).toEqual(withPartners);
    const users = { ...withPartners.users, '8': { login: 'heidi', role: 'trial' as const } };
    const dropped = await fixture.request(
      '/permissions',
      'PUT',
      { revision: loaded.revision, permissions: { users } },
      MAINTAINER,
    );
    expect(dropped.status).toBe(400);
    const edited = await fixture.request(
      '/permissions',
      'PUT',
      {
        revision: loaded.revision,
        permissions: { users, partners: { '5': { login: 'eve', projects: ['other'] } } },
      },
      MAINTAINER,
    );
    expect(edited.status).toBe(400);
    const kept = await fixture.request(
      '/permissions',
      'PUT',
      { revision: loaded.revision, permissions: { ...withPartners, users } },
      MAINTAINER,
    );
    expect(kept.status).toBe(200);
    expect(permissionsNow()).toEqual({ ...withPartners, users });
    // A file without partners still round-trips without the key.
    fixture.moveData({ 'config/permissions.json': config });
    const plain = await body(await fixture.request('/permissions', 'GET', undefined, MAINTAINER));
    expect(plain.permissions).toEqual(config);
    expect(
      (
        await fixture.request(
          '/permissions',
          'PUT',
          { revision: plain.revision, permissions: config },
          MAINTAINER,
        )
      ).status,
    ).toBe(200);
  });
});

describe('DELETE /exports/projects/:id', () => {
  const remove = (user = MAINTAINER, revision = revisionOf()) =>
    fixture.request('/exports/projects/dim', 'DELETE', { revision }, user);

  it('removes the config and the project from every partner in one maintainer commit', async () => {
    for (const id of [EDITOR, TRIAL, TRANSLATOR, PARTNER, NOBODY])
      expect((await remove(id)).status).toBe(403);
    expect((await remove(MAINTAINER, 'f'.repeat(40))).status).toBe(409);
    const commits = fixture.commits.length;
    const response = await remove();
    expect(response.status).toBe(200);
    expect((await body(response)).removed).toEqual(['dim/v1/descriptions.json']);
    expect(fixture.commits.length).toBe(commits + 1);
    expect(stored()).toBeUndefined();
    expect(permissionsNow().partners).toEqual({ '6': { login: 'frank', projects: ['other'] } });
    // Re-creating the id grants the old partner nothing.
    const created = await fixture.request(
      '/exports/projects',
      'POST',
      { config: dimConfig() },
      MAINTAINER,
    );
    expect(created.status).toBe(400); // client uid refused
    const fresh = {
      ...dimConfig(),
      files: [{ id: 'descriptions', formatVersion: 1, preset: 'dim' }],
    };
    expect(
      (await fixture.request('/exports/projects', 'POST', { config: fresh }, MAINTAINER)).status,
    ).toBe(201);
    expect((await put('dim', stored()!)).status).toBe(403);
    expect((await remove(MAINTAINER, 'f'.repeat(40))).status).toBe(409);
  });
});

describe('CAS races', () => {
  it('two saves: the second, built on the same revision, gets 409 (also when it races inside the CAS)', async () => {
    const first = { ...dimConfig(), files: [...dimConfig().files, styleFile('one')] };
    const second = { ...dimConfig(), files: [...dimConfig().files, styleFile('two')] };
    const revision = revisionOf();
    fixture.beforePatch = () =>
      fixture.moveData({
        'exports/projects/dim.json': {
          ...first,
          files: [dimConfig().files[0], { ...first.files[1], uid: 'ffffffffffffffff' }],
        },
      });
    const racing = await put('dim', second, PARTNER, revision);
    expect(racing.status).toBe(409);
    expect(stored()!.files[1]!.id).toBe('one');
    later();
    expect((await put('dim', second, PARTNER, revision)).status).toBe(409);
  });

  it('save vs membership change: a partner removed during the save is refused on the retry', async () => {
    fixture.beforePatch = () => fixture.moveData({ 'config/permissions.json': config });
    const response = await put('dim', {
      ...dimConfig(),
      files: [...dimConfig().files, styleFile('x1')],
    });
    expect(response.status).toBe(403);
    expect(stored()).toEqual(dimConfig());
  });

  it('save vs delete: the retry finds no project', async () => {
    fixture.beforePatch = () => fixture.moveData({ 'exports/projects/dim.json': undefined });
    expect(
      (await put('dim', { ...dimConfig(), files: [...dimConfig().files, styleFile('x1')] })).status,
    ).toBe(404);
    expect(stored()).toBeUndefined();
  });

  it('delete vs save: the retry sees the newer revision', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({ 'exports/projects/dim.json': { ...dimConfig(), name: 'Changed' } });
    expect(
      (
        await fixture.request(
          '/exports/projects/dim',
          'DELETE',
          { revision: revisionOf() },
          MAINTAINER,
        )
      ).status,
    ).toBe(409);
    expect(stored()!.name).toBe('Changed');
  });

  it('cooldown is re-checked on the retry (a change and revert inside the window)', async () => {
    fixture.beforePatch = () => {
      fixture.moveData({ 'exports/projects/dim.json': { ...dimConfig(), name: 'Tmp' } });
      fixture.moveData({ 'exports/projects/dim.json': dimConfig() });
    };
    const response = await put('dim', {
      ...dimConfig(),
      files: [...dimConfig().files, styleFile('x1')],
    });
    expect(response.status).toBe(429);
    expect(stored()).toEqual(dimConfig());
  });

  it('an unrelated head move is retried and the save lands on the new head', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({ 'tooltips/124.json': { hash: 124, text: {}, associated: [] } });
    const response = await put('dim', {
      ...dimConfig(),
      files: [...dimConfig().files, styleFile('x1')],
    });
    expect(response.status).toBe(200);
    expect(fixture.current()['tooltips/124.json']).toBeDefined();
    expect(stored()!.files).toHaveLength(2);
  });

  it('membership change vs concurrent permissions edit: 409 on the retry', async () => {
    fixture.accounts = { grace: { id: 77, login: 'grace', type: 'User' } };
    fixture.beforePatch = () =>
      fixture.moveData({
        'config/permissions.json': {
          ...withPartners,
          users: { ...withPartners.users, '9': { login: 'ivan', role: 'trial' } },
        },
      });
    const response = await fixture.request(
      '/exports/projects/dim/partners',
      'PUT',
      { revision: blobOid(withPartners), logins: ['grace'] },
      MAINTAINER,
    );
    expect(response.status).toBe(409);
    expect(permissionsNow().partners).toEqual(withPartners.partners);
  });

  it('gives up after 3 ref races with 409 and bounded subrequests', async () => {
    fixture.patchRaces = 3;
    fixture.subrequests = 0;
    const response = await put('dim', {
      ...dimConfig(),
      files: [...dimConfig().files, styleFile('x1')],
    });
    expect(response.status).toBe(409);
    expect(fixture.subrequests).toBe(13); // token + 3 x (read, tree, commit, ref)
  });
});
