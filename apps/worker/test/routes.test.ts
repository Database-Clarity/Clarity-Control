// Deny by default (export spec section 4, G-AUTH): every Worker route x every role. The `partner`
// role must never get more than an account with no role on any route outside /exports, and an
// editor who is also a partner gets exactly what an editor gets. A static scan of the routers
// makes a new route fail this test until it is added to the table.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings, type Permissions } from '@clarity/core';
import type { ReportsDatabase } from '../src/reports.js';
import { blobOid, config, Fixture, makePrivateKey, tooltip } from './fixture.js';

const privateKey = await makePrivateKey();
const roles = {
  maintainer: 1,
  editor: 2,
  trial: 3,
  translator: 4,
  partner: 5,
  none: 7,
} as const;
type Role = keyof typeof roles;

const dim = {
  schema: 1,
  id: 'dim',
  name: 'DIM',
  files: [{ id: 'descriptions', uid: 'aaaaaaaaaaaaaaaa', formatVersion: 1, preset: 'dim' }],
};
const permissions = (editorIsPartner = false): Permissions => ({
  ...config,
  partners: {
    '5': { login: 'eve', projects: ['dim'] },
    ...(editorIsPartner ? { '2': { login: 'bob', projects: ['dim'] } } : {}),
  },
});

/** A D1 stand-in with no rows: enough for the reports router to reach its access checks. */
function emptyDatabase(): ReportsDatabase {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
    raw: async () => [],
  };
  return { prepare: () => statement, batch: async () => [] } as unknown as ReportsDatabase;
}

const R = 'r-aaaaaaaa';
type Route = { method: string; path: string; body?: unknown };
/** Every route outside /exports. `public` routes need no session at all. */
const routes: (Route & { public?: true })[] = [
  { method: 'GET', path: '/auth/login', public: true },
  { method: 'GET', path: '/auth/callback', public: true },
  { method: 'GET', path: '/publish/key', public: true },
  { method: 'POST', path: '/publish', body: {} },
  { method: 'GET', path: `/publish/status?opId=0${'A'.repeat(25)}` },
  { method: 'POST', path: '/publish/kick', body: {} },
  { method: 'POST', path: '/compendium/refresh', body: {} },
  { method: 'GET', path: '/compendium/refresh/status' },
  { method: 'GET', path: '/compendium/agent-guidance' },
  { method: 'POST', path: '/compendium/agent-guidance', body: { document: 'x', revision: null } },
  { method: 'GET', path: '/me' },
  {
    method: 'POST',
    path: '/save',
    body: { changes: [{ hash: 123, base: tooltip(), next: tooltip('x') }], message: 'x' },
  },
  { method: 'POST', path: '/push-live', body: { hashes: [123] } },
  { method: 'GET', path: '/settings' },
  { method: 'PUT', path: '/settings', body: { settings: defaultSyncedSettings, revision: null } },
  { method: 'GET', path: '/permissions' },
  { method: 'PUT', path: '/permissions', body: { revision: 'a'.repeat(40), permissions: config } },
  { method: 'GET', path: '/sandbox-pointers' },
  { method: 'PUT', path: '/sandbox-pointers', body: { revision: null, picks: {} } },
  { method: 'GET', path: '/history/123' },
  { method: 'GET', path: '/reports/public?hash=123&lang=en', public: true },
  { method: 'GET', path: `/reports/r/${R}`, public: true },
  { method: 'POST', path: '/reports', body: {} },
  { method: 'POST', path: `/reports/r/${R}/view`, body: {} },
  { method: 'POST', path: `/reports/r/${R}/withdraw`, body: {} },
  { method: 'GET', path: '/reports/mine' },
  { method: 'GET', path: `/reports/${R}/files/1` },
  { method: 'DELETE', path: `/reports/${R}/files/1` },
  { method: 'POST', path: `/reports/${R}/files`, body: {} },
  { method: 'GET', path: '/reports/index' },
  { method: 'GET', path: '/reports' },
  { method: 'GET', path: '/reports/admin' },
  { method: 'GET', path: '/reports/list' },
  { method: 'POST', path: '/reports/admin', body: {} },
  { method: 'DELETE', path: `/reports/${R}` },
  { method: 'POST', path: `/reports/${R}/action`, body: {} },
];
/** Routes a signed-in account with no role may use (today's behaviour, unchanged). */
const anyAccount = new Set(['GET /me', 'GET /reports/mine']);

let fixture: Fixture;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-11T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(editorIsPartner = false) {
  fixture = new Fixture(privateKey);
  fixture.env.REPORTS_DB = emptyDatabase();
  fixture.env.REPORTS_FILES_DB = emptyDatabase();
  // The guidance route answers only for the production repository names.
  fixture.env.GITHUB_OWNER = 'Database-Clarity';
  fixture.env.GITHUB_REPO = 'Live-Clarity-Database';
  fixture.accounts = { grace: { id: 77, login: 'grace', type: 'User' } };
  fixture.moveData({
    'config/permissions.json': permissions(editorIsPartner),
    'exports/projects/dim.json': dim,
  });
  vi.setSystemTime(Date.now() + 3_600_000);
  return fixture;
}

async function status(route: Route, id: number | null, editorIsPartner = false) {
  const f = setup(editorIsPartner);
  const before = { commits: f.commits.length, writes: f.writes.length, head: f.dataHead };
  const response =
    id === null
      ? await (
          await import('../src/index.js')
        ).default.fetch(
          new Request(`https://api.example${route.path}`, {
            method: route.method,
            headers: { Origin: f.env.SITE_ORIGIN },
            ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
          }),
          f.env,
          { waitUntil() {} },
        )
      : await f.request(route.path, route.method, route.body, id);
  const wrote =
    f.commits.length !== before.commits ||
    f.writes.length !== before.writes ||
    f.dataHead !== before.head;
  return { status: response.status, wrote };
}

describe('deny by default outside /exports', () => {
  for (const route of routes) {
    it(`${route.method} ${route.path}`, async () => {
      const none = await status(route, roles.none);
      const partner = await status(route, roles.partner);
      expect(partner).toEqual(none);
      expect(partner.wrote).toBe(false);
      const key = `${route.method} ${route.path}`;
      if (!route.public && !anyAccount.has(key))
        expect(partner.status, `${key} must refuse a partner`).toBeGreaterThanOrEqual(400);
      // An editor who is also a partner gets exactly the editor's answer.
      expect((await status(route, roles.editor, true)).status).toBe(
        (await status(route, roles.editor)).status,
      );
    });
  }
});

describe('/exports route table', () => {
  const revision = blobOid(dim);
  const table: { route: Route; allowed: Partial<Record<Role, number>> }[] = [
    {
      route: { method: 'GET', path: '/exports/projects' },
      allowed: { maintainer: 200, partner: 200 },
    },
    {
      route: {
        method: 'POST',
        path: '/exports/projects',
        body: { config: { schema: 1, id: 'new-one', name: 'N', files: [] } },
      },
      allowed: { maintainer: 201 },
    },
    {
      route: {
        method: 'PUT',
        path: '/exports/projects/dim',
        body: { revision, config: { ...dim, files: [] } },
      },
      allowed: { maintainer: 200, partner: 200 },
    },
    {
      route: {
        method: 'PUT',
        path: '/exports/projects/dim/partners',
        body: { revision: blobOid(permissions()), logins: ['grace'] },
      },
      allowed: { maintainer: 200 },
    },
    {
      route: { method: 'DELETE', path: '/exports/projects/dim', body: { revision } },
      allowed: { maintainer: 200 },
    },
  ];
  for (const { route, allowed } of table) {
    for (const role of Object.keys(roles) as Role[]) {
      const expected = allowed[role] ?? 403;
      it(`${route.method} ${route.path} as ${role} -> ${expected}`, async () => {
        const result = await status(route, roles[role]);
        expect(result.status).toBe(expected);
        expect(result.wrote).toBe(expected !== 403 && route.method !== 'GET');
      });
    }
    it(`${route.method} ${route.path} without a session -> 401`, async () => {
      expect((await status(route, null)).status).toBe(401);
    });
  }
  it('a partner of another project is refused on dim', async () => {
    const f = setup();
    f.moveData({
      'config/permissions.json': {
        ...config,
        partners: { '5': { login: 'eve', projects: ['other'] } },
      },
    });
    later();
    const response = await f.request(
      '/exports/projects/dim',
      'PUT',
      { revision, config: dim },
      roles.partner,
    );
    expect(response.status).toBe(403);
  });
  it('unknown methods and sub-paths under /exports are 404', async () => {
    for (const [method, path] of [
      ['PATCH', '/exports/projects/dim'],
      ['GET', '/exports/projects/dim'],
      ['GET', '/exports/projects/dim/partners'],
      ['PUT', '/exports/projects'],
      ['GET', '/exports'],
      ['GET', '/exports/projects/dim/partners/x'],
    ] as const)
      expect((await status({ method, path }, roles.maintainer)).status).toBe(404);
  });
});

function later() {
  vi.setSystemTime(Date.now() + 31_000);
}

it('the table covers every route the routers name', () => {
  const sources = ['src/index.ts', 'src/reports.ts'].map((file) =>
    readFileSync(`apps/worker/${file}`, 'utf8'),
  );
  const named = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/path === '([^']+)'/g)) named.add(match[1]!);
    for (const match of source.matchAll(/\['([^\]]+)'\]\.includes\(path\)/g))
      for (const path of match[1]!.split(/',\s*'/)) named.add(path);
  }
  const covered = [...routes.map((route) => route.path.split('?')[0]!), '/exports/projects'];
  for (const path of named)
    expect(covered, `route ${path} is missing from the table`).toContain(path);
  // Pattern routes: each regex in the routers matches at least one table path.
  const patterns = sources.flatMap((source) =>
    [...source.matchAll(/= (\/\^\\\/(?:history|reports)[^\n]*?\$\/)\.exec\(path\)/g)].map(
      (match) => match[1]!,
    ),
  );
  expect(patterns.length).toBeGreaterThanOrEqual(4);
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.slice(1, -1));
    expect(
      covered.some((path) => regex.test(path)),
      `pattern ${pattern} is not covered`,
    ).toBe(true);
  }
  // The exports router: every path it accepts is in the /exports table above.
  const exportsSource = readFileSync('apps/worker/src/exports.ts', 'utf8');
  expect(exportsSource.match(/method === '(GET|POST|PUT|DELETE)'/g)).toHaveLength(5);
});
