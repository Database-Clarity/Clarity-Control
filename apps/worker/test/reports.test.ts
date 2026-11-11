import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';
import { Fixture } from './fixture.js';
import { signToken } from '../src/crypto.js';
import { type ReportsDatabase, reportIP, purgeReports } from '../src/reports.js';
import { reportImage } from '../src/reportsFiles.js';

let proxy: Awaited<
  ReturnType<
    typeof getPlatformProxy<{ REPORTS_DB: ReportsDatabase; REPORTS_FILES_DB: ReportsDatabase }>
  >
>;
let db: ReportsDatabase, files: ReportsDatabase, fixture: Fixture;
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const payload = () => ({
  request_id: crypto.randomUUID(),
  withdraw_secret: 'a'.repeat(43),
  viewed_hash: 123,
  lang: 'en',
  rev: 'a'.repeat(16),
  data_commit: '1'.repeat(40),
  category: 'wrong-value',
  note: 'tested in the current patch',
  notes: [
    {
      category: 'wrong-value',
      text: 'Wrong value',
      anchor: {
        rev: 'a'.repeat(16),
        exact: 'x',
        prefix: '',
        suffix: '',
        start: 0,
        end: 1,
        line: 0,
      },
    },
  ],
  links: [],
  turnstile: 'valid',
});
async function call(path: string, method = 'GET', data?: unknown, id?: number, ip = '192.0.2.1') {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
  };
  if (id)
    headers.Authorization = `Bearer ${await signToken({ purpose: 'session', id, login: `user${id}`, exp: Math.floor(Date.now() / 1000) + 3600 }, fixture.env.SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://api.example${path}`, {
      method,
      headers,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    }),
    fixture.env,
    { waitUntil() {} },
  );
}
beforeAll(async () => {
  proxy = await getPlatformProxy<{
    REPORTS_DB: ReportsDatabase;
    REPORTS_FILES_DB: ReportsDatabase;
  }>({ configPath: 'apps/worker/wrangler.jsonc', persist: false });
  db = proxy.env.REPORTS_DB;
  files = proxy.env.REPORTS_FILES_DB;
  for (const [name, database] of [
    ['reports', db],
    ['files', files],
  ] as const) {
    const source = readFileSync(`apps/worker/migrations/${name}/0001_${name}.sql`, 'utf8');
    // exec is line-oriented; use prepare so triggers remain a single statement.
    const clean = source.replace(/--[^\n]*/g, '');
    const triggerAt = clean.indexOf('CREATE TRIGGER');
    const statements =
      triggerAt < 0
        ? clean.split(';').filter((s) => s.trim())
        : [
            ...clean
              .slice(0, triggerAt)
              .split(';')
              .filter((s) => s.trim()),
            ...clean.slice(triggerAt).matchAll(/CREATE TRIGGER[\s\S]+?END;/g),
          ].map((s) => (typeof s === 'string' ? s : s[0]));
    for (const statement of statements) await database.prepare(statement).run();
  }
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await proxy?.dispose();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch(
    [
      'DELETE FROM reports',
      'DELETE FROM limits',
      'DELETE FROM reporters',
      'DELETE FROM tombstones',
      "UPDATE meta SET value='0' WHERE key LIKE 'pause_%'",
    ].map((s) => db.prepare(s)),
  );
  await files.prepare('DELETE FROM files').run();
  fixture = new Fixture(privateKey);
  fixture.env.REPORTS_DB = db;
  fixture.env.REPORTS_FILES_DB = files;
  fixture.env.TURNSTILE_SECRET = 'test-secret';
  const upstream = fixture.fetch.bind(fixture);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes('report-items.worker.json'))
        return new Response(
          JSON.stringify({
            sourceCommit: '1'.repeat(40),
            items: { 123: { owner: 123, langs: ['en', 'de'], variant: 'base' } },
          }),
        );
      if (value.includes('siteverify'))
        return new Response(
          JSON.stringify({ success: true, hostname: 'editor.example', action: 'report' }),
        );
      return upstream(url, init);
    }),
  );
});
describe('reports local D1', () => {
  it('migrates both stores, submits anonymously, and retries without spending a limit', async () => {
    const input = payload();
    const sent = await call('/reports', 'POST', input);
    expect(sent.status).toBe(201);
    const result = (await sent.json()) as { id: string };
    const retry = await call('/reports', 'POST', { ...input, turnstile: 'consumed' });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: result.id, status: 'open' });
    expect((await call('/reports', 'POST', { ...input, note: 'changed' })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 1 });
    expect((await call(`/reports/r/${result.id}/view`, 'POST', { secret: 'wrong' })).status).toBe(
      403,
    );
    expect(
      (await call(`/reports/r/${result.id}/view`, 'POST', { secret: input.withdraw_secret }))
        .status,
    ).toBe(200);
  });
  it('rolls back all counters and report inserts for concurrent ceiling failures', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call('/reports', 'POST', payload())),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 429, 429]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 3 });
    expect(await db.prepare("SELECT count FROM limits WHERE key LIKE 'ipday:%'").first()).toEqual({
      count: 3,
    });
  });
  it('handles concurrent retries as one report', async () => {
    const input = payload();
    const responses = await Promise.all([
      call('/reports', 'POST', input),
      call('/reports', 'POST', input),
    ]);
    expect(responses.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 1 });
  });
  it.each([undefined, 5, 4, 3, 2, 1])(
    'enforces reads, actions, receipts, and deletion for identity %s',
    async (id) => {
      const response = await call('/reports', 'POST', payload(), id);
      expect(response.status).toBe(201);
      const { id: report } = (await response.json()) as { id: string };
      const role = id !== undefined && id <= 4;
      expect((await call('/reports/index', 'GET', undefined, id)).status).toBe(role ? 200 : 403);
      const allowed = role && id !== 4;
      expect((await call('/reports?hash=123&lang=en', 'GET', undefined, id)).status).toBe(
        allowed ? 200 : 403,
      );
      expect(
        (
          await call(
            `/reports/${report}/action`,
            'POST',
            { action: 'triage', expected_version: 1 },
            id,
          )
        ).status,
      ).toBe(allowed ? 200 : 403);
      expect((await call(`/reports/${report}`, 'DELETE', undefined, id)).status).toBe(
        id === 1 ? 200 : 403,
      );
    },
  );
  it('allows translators to act only in the stored assigned locale', async () => {
    const input = { ...payload(), lang: 'de' };
    const created = await call('/reports', 'POST', input, 4);
    const { id } = (await created.json()) as { id: string };
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'triage', expected_version: 1 }, 4))
        .status,
    ).toBe(200);
  });
  it('withdraws, redacts selectors, bumps marker revision, and leaves a tombstone on purge', async () => {
    const input = payload(),
      sent = await call('/reports', 'POST', input),
      { id } = (await sent.json()) as { id: string };
    const index = await call('/reports/index', 'GET', undefined, 1),
      etag = index.headers.get('ETag');
    expect(
      (await call(`/reports/r/${id}/withdraw`, 'POST', { secret: input.withdraw_secret })).status,
    ).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM notes').first()).toEqual({ n: 0 });
    const next = await call('/reports/index', 'GET', undefined, 1);
    expect(next.headers.get('ETag')).not.toBe(etag);
    await db.prepare('UPDATE reports SET updated_at=0').run();
    await purgeReports(fixture.env);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tombstones').first()).toEqual({ n: 1 });
  });
  it('never exposes reporter strings, quotes, or links in the public response', async () => {
    await call('/reports', 'POST', payload());
    const response = await call('/reports/public?hash=123&lang=en');
    const text = await response.text();
    for (const field of [
      'reporter',
      'exact',
      'prefix',
      'Wrong value',
      'tested',
      'source_url',
      'links',
    ])
      expect(text).not.toContain(field);
  });
  it.each([
    { success: false },
    { success: true, hostname: 'evil.example', action: 'report' },
    { success: true, hostname: 'editor.example', action: 'login' },
    null,
  ])('fails closed for Turnstile %j', async (result) => {
    const upstream = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('siteverify')) {
          if (result === null) throw new Error('offline');
          return new Response(JSON.stringify(result));
        }
        return upstream(url, init);
      }),
    );
    expect((await call('/reports', 'POST', payload())).status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
  });
  it('respects both pause switches and account blocks without spending Turnstile', async () => {
    await db.prepare("UPDATE meta SET value='1' WHERE key='pause_anonymous'").run();
    expect((await call('/reports', 'POST', payload())).status).toBe(503);
    expect((await call('/reports', 'POST', payload(), 5)).status).toBe(201);
    await db.prepare("UPDATE meta SET value='1' WHERE key='pause_all'").run();
    expect((await call('/reports', 'POST', payload(), 1)).status).toBe(503);
    await db.prepare("UPDATE meta SET value='0' WHERE key LIKE 'pause_%'").run();
    await db.prepare("INSERT INTO blocked VALUES(5,'owner',0,NULL)").run();
    expect((await call('/reports', 'POST', payload(), 5)).status).toBe(403);
    await db.prepare('DELETE FROM blocked').run();
  });
  it('rejects invalid selector bounds, bidi, unsupported links, and oversized bodies', async () => {
    const input = payload();
    input.notes[0].anchor.end = 5000;
    expect((await call('/reports', 'POST', input)).status).toBe(400);
    expect((await call('/reports', 'POST', { ...payload(), note: '\u202ehidden' })).status).toBe(
      400,
    );
    expect(
      (await call('/reports', 'POST', { ...payload(), links: ['https://discord.com/x'] })).status,
    ).toBe(400);
    expect((await call('/reports', 'POST', { ...payload(), note: 'x'.repeat(10000) })).status).toBe(
      413,
    );
  });
  it('never deletes report data when the files database deletion fails', async () => {
    const input = payload(),
      response = await call('/reports', 'POST', input),
      { id } = (await response.json()) as { id: string };
    fixture.env.REPORTS_FILES_DB = {
      ...files,
      prepare() {
        throw new Error('files offline');
      },
    };
    expect(
      (await call(`/reports/r/${id}/withdraw`, 'POST', { secret: input.withdraw_secret })).status,
    ).toBe(502);
    expect(await db.prepare('SELECT status FROM reports').first()).toEqual({ status: 'open' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM notes').first()).toEqual({ n: 1 });
    fixture.env.REPORTS_FILES_DB = files;
  });
});
it('normalises IPv6 /64 equivalents', () => {
  expect(reportIP('2001:0db8:0001:0002:abcd::1')).toBe(reportIP('2001:db8:1:2::2'));
  expect(reportIP('::1')).toBe('0:0:0:0');
});
it('refuses non-image uploads', () =>
  expect(() => reportImage(new TextEncoder().encode('<svg/>'))).toThrow());
