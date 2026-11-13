import { readFileSync, writeFileSync } from 'node:fs';
import { reportBudget } from './reportsBudget.js';
import { reportBudgetCases, mergeBudgetRows } from './reportsBudgetCases.js';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';
import { Fixture } from './fixture.js';
import { signToken } from '../src/crypto.js';
import {
  type ReportsDatabase,
  type ReportStatement,
  reportIP,
  purgeReports,
} from '../src/reports.js';
import { reportImage } from '../src/reportsFiles.js';
import { reportJpegFixture } from './reportsImages.js';

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
  owner_hash: 123,
  variant: 'base',
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
async function call(
  path: string,
  method = 'GET',
  data?: unknown,
  id?: number,
  ip = '192.0.2.1',
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    ...extra,
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
  await files.batch(
    [
      'DELETE FROM files',
      'DELETE FROM files_closed',
      'DELETE FROM limits',
      "DELETE FROM meta WHERE key='sweep_cursor'",
      "UPDATE meta SET value='0' WHERE key='size_after'",
    ].map((s) => files.prepare(s)),
  );
  fixture = new Fixture(privateKey);
  fixture.env.REPORTS_DB = db;
  fixture.env.REPORTS_FILES_DB = files;
  fixture.env.TURNSTILE_SECRET = 'test-secret';
  const upstream = fixture.fetch.bind(fixture);
  const budgetCatalog = JSON.stringify({
    sourceCommit: '1'.repeat(40),
    items: Object.fromEntries(
      Array.from({ length: 1695 }, (_, i) => [
        i + 1,
        { owner: i + 1, langs: ['en', 'de', 'fr'], variant: 'base' },
      ]),
    ),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes('report-items.worker.json'))
        if (process.env.REPORTS_BUDGET) return new Response(budgetCatalog);
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
  it.each([
    { owner_hash: 456, variant: 'base' },
    { owner_hash: 123, variant: 'enhanced' },
    { owner_hash: undefined, variant: undefined },
  ])(
    'refuses a different or missing rendered mapping at the same source commit: %j',
    async (mapping) => {
      const response = await call('/reports', 'POST', { ...payload(), ...mapping });
      expect(response.status).toBe(409);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('siteverify')),
      ).toHaveLength(0);
    },
  );

  it('refuses an unavailable rendered language instead of substituting English', async () => {
    expect((await call('/reports', 'POST', { ...payload(), lang: 'fr' })).status).toBe(422);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
  });

  it('refuses stale data commits before consuming a human check or storing another owner’s report', async () => {
    const response = await call('/reports', 'POST', { ...payload(), data_commit: '2'.repeat(40) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Tooltip data changed; reload before sending' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('siteverify')),
    ).toHaveLength(0);
  });

  it('keeps the public selector projection current through reanchor, close, reopen, and withdrawal', async () => {
    const input = payload();
    input.notes = [input.notes[0], { ...input.notes[0], category: 'wording' }];
    const sent = await call('/reports', 'POST', input),
      { id } = (await sent.json()) as { id: string };
    const anchor = { ...input.notes[0].anchor, rev: 'b'.repeat(16), exact: 'y', start: 1, end: 2 };
    expect(
      (
        await call(
          `/reports/${id}/action`,
          'POST',
          { action: 'reanchor', expected_version: 1, n: 1, anchor },
          1,
        )
      ).status,
    ).toBe(200);
    const projected = (await (await call('/reports/public?hash=123&lang=en')).json()) as {
      n: number;
      rev: string;
      start: number;
    }[];
    expect(projected.find((n) => n.n === 1)).toMatchObject({ rev: anchor.rev, start: 1 });
    expect(projected.find((n) => n.n === 2)).toMatchObject({ rev: input.rev, start: 0 });
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'close', expected_version: 2 }, 1))
        .status,
    ).toBe(200);
    expect(await (await call('/reports/public?hash=123&lang=en')).json()).toEqual([]);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'reopen', expected_version: 3 }, 1))
        .status,
    ).toBe(200);
    expect(await (await call('/reports/public?hash=123&lang=en')).json()).toHaveLength(2);
    expect(
      (await call(`/reports/r/${id}/withdraw`, 'POST', { secret: input.withdraw_secret })).status,
    ).toBe(200);
    expect(await (await call('/reports/public?hash=123&lang=en')).json()).toEqual([]);
    expect(
      await db.prepare('SELECT public_anchors FROM reports WHERE id=?').bind(id).first(),
    ).toEqual({ public_anchors: '[]' });
  });
  const publicReadEvidence: {
    reports: number;
    notes_per_report: number;
    anchors: number;
    rows_read: number;
  }[] = [];
  it.each([
    [19, 1],
    [20, 1],
    [21, 1],
    [100, 1],
    [100, 5],
    [2, 5],
  ])(
    'caps the public read at 40 D1 rows with %s reports and %s notes each',
    async (reportCount, noteCount) => {
      await db
        .prepare(
          "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) SELECT 'public-'||x,123,123,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','other','private','anonymous','public-'||x,'test',x,x FROM n",
        )
        .bind(reportCount)
        .run();
      await db
        .prepare(
          "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO notes(report_id,n,category,text,exact,prefix,suffix,start,end,line,whole) SELECT r.id,n.x,'other','private','x','','',0,1,0,0 FROM reports r CROSS JOIN n",
        )
        .bind(noteCount)
        .run();
      let reads = -1;
      const wrap = (original: ReportStatement): ReportStatement => ({
        bind(...args) {
          return wrap(original.bind(...args));
        },
        first<T>() {
          return original.first<T>();
        },
        async all<T>() {
          const result = await original.all<T>();
          reads = result.meta?.rows_read ?? -1;
          return result;
        },
        run() {
          return original.run();
        },
      });
      fixture.env.REPORTS_DB = {
        prepare(query) {
          const original = db.prepare(query);
          return query.includes('INDEXED BY reports_public') ? wrap(original) : original;
        },
        batch(statements) {
          return db.batch(statements);
        },
        exec(query) {
          return db.exec(query);
        },
      };
      const response = await call('/reports/public?hash=123&lang=en');
      expect(response.status).toBe(200);
      const rows = (await response.json()) as { age: number }[];
      expect(rows).toHaveLength(Math.min(20, reportCount * noteCount));
      expect(Math.min(...rows.map((row) => row.age))).toBeGreaterThanOrEqual(
        Math.max(1, reportCount + 1 - Math.ceil(20 / noteCount)),
      );
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(40);
      publicReadEvidence.push({
        reports: reportCount,
        notes_per_report: noteCount,
        anchors: rows.length,
        rows_read: reads,
      });
      if (process.env.REPORTS_PUBLIC_EVIDENCE_OUTPUT)
        writeFileSync(
          process.env.REPORTS_PUBLIC_EVIDENCE_OUTPUT,
          JSON.stringify(publicReadEvidence, null, 2),
        );
      fixture.env.REPORTS_DB = db;
    },
  );
  async function uploadRaceCase(operation: 'withdraw' | 'spam' | 'delete') {
    const input = payload();
    const response = await call('/reports', 'POST', input, 5),
      { id } = (await response.json()) as { id: string };
    const token = await signToken(
      { purpose: 'session', id: 5, login: 'user5', exp: Math.floor(Date.now() / 1000) + 3600 },
      fixture.env.SESSION_SECRET,
    );
    const upload = () =>
      worker.fetch(
        new Request(`https://api.example/reports/${id}/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'image/jpeg',
            'X-Report-Request-Id': input.request_id,
          },
          body: reportJpegFixture(),
        }),
        fixture.env,
        { waitUntil() {} },
      );
    const close = () =>
      operation === 'withdraw'
        ? call(`/reports/r/${id}/withdraw`, 'POST', {}, 5)
        : operation === 'spam'
          ? call(`/reports/${id}/action`, 'POST', { action: 'spam', expected_version: 1 }, 1)
          : call(`/reports/${id}`, 'DELETE', undefined, 1);
    return { id, upload, close };
  }
  it('restores only status when spam is undone, never images or the upload capability', async () => {
    const race = await uploadRaceCase('spam');
    expect((await race.upload()).status).toBe(201);
    expect((await race.close()).status).toBe(200);
    expect(
      (
        await call(
          `/reports/${race.id}/action`,
          'POST',
          { action: 'reopen', expected_version: 2 },
          1,
        )
      ).status,
    ).toBe(200);
    expect(
      await db.prepare('SELECT status,files_count FROM reports WHERE id=?').bind(race.id).first(),
    ).toEqual({ status: 'open', files_count: 0 });
    expect((await race.upload()).status).toBe(409);
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
  });
  function interceptStatement(
    statement: ReportStatement,
    before: () => Promise<void>,
  ): ReportStatement {
    return {
      bind(...values) {
        return interceptStatement(statement.bind(...values), before);
      },
      first<T>() {
        return statement.first<T>();
      },
      all<T>() {
        return statement.all<T>();
      },
      async run() {
        await before();
        return statement.run();
      },
    };
  }
  function beforeCoreWrite(prefix: string, before: () => Promise<void>) {
    fixture.env.REPORTS_DB = {
      prepare(query) {
        const statement = db.prepare(query);
        return query.startsWith(prefix) ? interceptStatement(statement, before) : statement;
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
  }
  for (const operation of ['deletion', 'upload'] as const)
    it(`does not apply pending attachment ${operation} bookkeeping across spam Undo`, async () => {
      const race = await uploadRaceCase('spam');
      if (operation === 'deletion') expect((await race.upload()).status).toBe(201);
      let raced = false;
      beforeCoreWrite(
        `UPDATE reports SET files_count=files_count${operation === 'upload' ? '+' : '-'}1`,
        async () => {
          if (raced) return;
          raced = true;
          expect((await race.close()).status).toBe(200);
          expect(
            (
              await call(
                `/reports/${race.id}/action`,
                'POST',
                { action: 'reopen', expected_version: 2 },
                1,
              )
            ).status,
          ).toBe(200);
        },
      );
      const response =
        operation === 'upload'
          ? await race.upload()
          : await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5);
      expect(response.status).toBe(operation === 'upload' ? 409 : 200);
      expect(raced).toBe(true);
      expect(
        await db.prepare('SELECT status,files_count,files_bytes FROM reports').first(),
      ).toEqual({
        status: 'open',
        files_count: 0,
        files_bytes: 0,
      });
      expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
      expect((await race.upload()).status).toBe(409);
      fixture.env.REPORTS_DB = db;
    });
  it('does not subtract a pending deletion after the thirty-day attachment sweep', async () => {
    const race = await uploadRaceCase('withdraw');
    expect((await race.upload()).status).toBe(201);
    expect((await race.upload()).status).toBe(201);
    let raced = false;
    beforeCoreWrite('UPDATE reports SET files_count=files_count-1', async () => {
      if (raced) return;
      raced = true;
      expect(
        (
          await call(
            `/reports/${race.id}/action`,
            'POST',
            { action: 'close', expected_version: 1 },
            1,
          )
        ).status,
      ).toBe(200);
      await db
        .prepare('UPDATE reports SET updated_at=? WHERE id=?')
        .bind(Math.floor(Date.now() / 1000) - 31 * 86400, race.id)
        .run();
      await purgeReports(fixture.env);
    });
    expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(raced).toBe(true);
    expect(await db.prepare('SELECT status,files_count,files_bytes FROM reports').first()).toEqual({
      status: 'closed',
      files_count: 0,
      files_bytes: 0,
    });
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
    fixture.env.REPORTS_DB = db;
  });
  it('does not write audit rows for repeated or missing attachment deletion', async () => {
    const race = await uploadRaceCase('withdraw');
    expect((await race.upload()).status).toBe(201);
    for (let count = 0; count < 3; count++)
      expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='delete-attachment'").first(),
    ).toEqual({ n: 1 });
  });
  it('never restores attachment actor history after concurrent withdrawal', async () => {
    const race = await uploadRaceCase('withdraw');
    expect((await race.upload()).status).toBe(201);
    let raced = false;
    fixture.env.REPORTS_DB = {
      prepare(query) {
        const statement = db.prepare(query);
        return query.startsWith('INSERT INTO events')
          ? interceptStatement(statement, async () => {
              if (!raced) {
                raced = true;
                expect((await race.close()).status).toBe(200);
              }
            })
          : statement;
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
    expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(raced).toBe(true);
    const receipt = await call(`/reports/r/${race.id}/view`, 'POST', {}, 1);
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ status: 'withdrawn', events: [] });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first()).toEqual({ n: 0 });
    fixture.env.REPORTS_DB = db;
  });
  it('preserves completed concurrent uploads when deleting an attachment', async () => {
    const race = await uploadRaceCase('withdraw');
    expect((await race.upload()).status).toBe(201);
    let raced = false;
    fixture.env.REPORTS_DB = {
      prepare(query) {
        const statement = db.prepare(query);
        return query.startsWith('UPDATE reports SET files_count=')
          ? interceptStatement(statement, async () => {
              if (!raced) {
                raced = true;
                expect((await race.upload()).status).toBe(201);
              }
            })
          : statement;
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
    expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(raced).toBe(true);
    expect(
      await files.prepare('SELECT COUNT(*) AS n,SUM(size) AS bytes FROM files').first(),
    ).toEqual({
      n: 1,
      bytes: reportJpegFixture().length,
    });
    expect(await db.prepare('SELECT files_count,files_bytes FROM reports').first()).toEqual({
      files_count: 1,
      files_bytes: reportJpegFixture().length,
    });
    fixture.env.REPORTS_DB = db;
  });
  it('commutes attachment deletion with pending upload bookkeeping and repeated deletion', async () => {
    const race = await uploadRaceCase('withdraw');
    let raced = false;
    fixture.env.REPORTS_DB = {
      prepare(query) {
        const statement = db.prepare(query);
        return query.startsWith('UPDATE reports SET files_count=files_count+1')
          ? interceptStatement(statement, async () => {
              if (!raced) {
                raced = true;
                expect(
                  (await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status,
                ).toBe(200);
              }
            })
          : statement;
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
    expect((await race.upload()).status).toBe(201);
    expect(raced).toBe(true);
    expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT files_count,files_bytes FROM reports').first()).toEqual({
      files_count: 0,
      files_bytes: 0,
    });
    fixture.env.REPORTS_DB = db;
  });
  it('does not subtract attachment totals after concurrent withdrawal clears them', async () => {
    const race = await uploadRaceCase('withdraw');
    expect((await race.upload()).status).toBe(201);
    let raced = false;
    fixture.env.REPORTS_DB = {
      prepare(query) {
        const statement = db.prepare(query);
        return query.startsWith('UPDATE reports SET files_count=')
          ? interceptStatement(statement, async () => {
              if (!raced) {
                raced = true;
                expect((await race.close()).status).toBe(200);
              }
            })
          : statement;
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
    expect((await call(`/reports/${race.id}/files/1`, 'DELETE', undefined, 5)).status).toBe(200);
    expect(raced).toBe(true);
    expect(await db.prepare('SELECT status,files_count,files_bytes FROM reports').first()).toEqual({
      status: 'withdrawn',
      files_count: 0,
      files_bytes: 0,
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first()).toEqual({ n: 0 });
    fixture.env.REPORTS_DB = db;
  });
  for (const operation of ['withdraw', 'spam', 'delete'] as const) {
    it(`${operation} rejects an upload between file removal and report finalisation`, async () => {
      const race = await uploadRaceCase(operation);
      expect((await race.upload()).status).toBe(201);
      let raced = false;
      const before = async () => {
        if (!raced) {
          raced = true;
          expect((await race.upload()).status).toBe(409);
        }
      };
      fixture.env.REPORTS_DB = {
        prepare(query) {
          const statement = db.prepare(query);
          return query.startsWith('DELETE FROM reports')
            ? interceptStatement(statement, before)
            : statement;
        },
        async batch(statements) {
          await before();
          return db.batch(statements);
        },
        exec(query) {
          return db.exec(query);
        },
      };
      expect((await race.close()).status).toBe(200);
      expect(raced).toBe(true);
      expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
      expect(await files.prepare('SELECT report_id FROM files_closed').first()).toEqual({
        report_id: race.id,
      });
      fixture.env.REPORTS_DB = db;
    });
    it(`${operation} fences an upload that passed its open-status read before removal`, async () => {
      const race = await uploadRaceCase(operation);
      let raced = false;
      fixture.env.REPORTS_FILES_DB = {
        prepare(query) {
          return files.prepare(query);
        },
        async batch(statements) {
          if (!raced) {
            raced = true;
            expect((await race.close()).status).toBe(200);
          }
          return files.batch(statements);
        },
        exec(query) {
          return files.exec(query);
        },
      };
      expect((await race.upload()).status).toBe(409);
      expect(raced).toBe(true);
      expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
      fixture.env.REPORTS_FILES_DB = files;
    });
    it(`${operation} removes a committed upload before its report counter can finalise`, async () => {
      const race = await uploadRaceCase(operation);
      let raced = false;
      const before = async () => {
        if (!raced) {
          raced = true;
          expect((await race.close()).status).toBe(200);
        }
      };
      fixture.env.REPORTS_DB = {
        prepare(query) {
          const statement = db.prepare(query);
          return query.startsWith('UPDATE reports SET files_count=files_count+1')
            ? interceptStatement(statement, before)
            : statement;
        },
        batch(statements) {
          return db.batch(statements);
        },
        exec(query) {
          return db.exec(query);
        },
      };
      expect((await race.upload()).status).toBe(409);
      expect(raced).toBe(true);
      expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
      const report = await db
        .prepare('SELECT files_count,status FROM reports WHERE id=?')
        .bind(race.id)
        .first();
      expect(report).toEqual(
        operation === 'delete'
          ? null
          : { files_count: 0, status: operation === 'spam' ? 'spam' : 'withdrawn' },
      );
      fixture.env.REPORTS_DB = db;
    });
  }
  it('uses note-level categories in the public anchor shape', async () => {
    const input = payload();
    input.notes = [
      { ...input.notes[0], category: 'wording' },
      { ...input.notes[0], category: 'translation' },
    ];
    expect((await call('/reports', 'POST', input)).status).toBe(201);
    const publicNotes = (await (await call('/reports/public?hash=123&lang=en')).json()) as {
      category: string;
    }[];
    expect(publicNotes.map((n) => n.category)).toEqual(['wording', 'translation']);
  });
  it('includes pagination state in the list ETag on insert and delete', async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) SELECT 'page-'||x,1000+x,1000+x,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','other','private','anonymous','page-'||x,'test',1,1 FROM n",
      )
      .run();
    const first = await call('/reports/list', 'GET', undefined, 1),
      etag = first.headers.get('ETag')!;
    expect(await first.json()).toMatchObject({ cursor: null });
    await db
      .prepare(
        "INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) VALUES('extra',1201,1201,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','other','private','anonymous','extra','test',1,1)",
      )
      .run();
    const added = await call('/reports/list', 'GET', undefined, 1, '192.0.2.1', {
      'If-None-Match': etag,
    });
    expect(added.status).toBe(200);
    const nextTag = added.headers.get('ETag')!;
    expect(await added.json()).toMatchObject({ cursor: '1200:en' });
    await db.prepare("DELETE FROM reports WHERE id='extra'").run();
    const removed = await call('/reports/list', 'GET', undefined, 1, '192.0.2.1', {
      'If-None-Match': nextTag,
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ cursor: null });
  });
  it('filters Age on the oldest matching report while retaining the whole group count', async () => {
    await db
      .prepare(
        "INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) VALUES('age-old',42,42,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','other','old','anonymous','age-old','test',10,20),('age-new',42,42,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','wording','new','anonymous','age-new','test',100,200)",
      )
      .run();
    const all = await call('/reports/list?since=10', 'GET', undefined, 1);
    expect(await all.json()).toMatchObject({
      rows: [{ owner_hash: 42, reports: 2, created_at: 10 }],
    });
    expect(await (await call('/reports/list?since=50', 'GET', undefined, 1)).json()).toMatchObject({
      rows: [],
    });
    expect(
      await (await call('/reports/list?since=50&category=wording', 'GET', undefined, 1)).json(),
    ).toMatchObject({ rows: [{ reports: 1, created_at: 100 }] });
    await db.prepare("DELETE FROM reports WHERE id='age-old'").run();
    expect(await (await call('/reports/list?since=50', 'GET', undefined, 1)).json()).toMatchObject({
      rows: [{ reports: 1, created_at: 100 }],
    });
    await db.prepare("UPDATE reports SET status='rejected' WHERE id='age-new'").run();
    expect(await (await call('/reports/list', 'GET', undefined, 1)).json()).toMatchObject({
      rows: [],
    });
    expect(
      await (await call('/reports/list?status=rejected', 'GET', undefined, 1)).json(),
    ).toMatchObject({ rows: [{ reports: 1 }] });
  });
  it('preserves screenshots for 30 days after stale closure and reconciles expired file totals', async () => {
    const response = await call('/reports', 'POST', payload(), 5),
      { id } = (await response.json()) as { id: string };
    await files
      .prepare("INSERT INTO files VALUES(?,1,5,'image/jpeg',64,'test',0,unhex(?))")
      .bind(id, Buffer.from(reportJpegFixture()).toString('hex'))
      .run();
    await db
      .prepare('UPDATE reports SET updated_at=0,files_count=1,files_bytes=64 WHERE id=?')
      .bind(id)
      .run();
    await purgeReports(fixture.env);
    expect(await db.prepare('SELECT status,files_count,files_bytes FROM reports').first()).toEqual({
      status: 'closed',
      files_count: 1,
      files_bytes: 64,
    });
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 1 });
    await db
      .prepare('UPDATE reports SET updated_at=? WHERE id=?')
      .bind(Math.floor(Date.now() / 1000) - 31 * 86400, id)
      .run();
    await purgeReports(fixture.env);
    expect(await db.prepare('SELECT status,files_count,files_bytes FROM reports').first()).toEqual({
      status: 'closed',
      files_count: 0,
      files_bytes: 0,
    });
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
  });
  it('accepts localhost Turnstile tokens only with the explicit local development switch', async () => {
    const upstream = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        String(url).includes('siteverify')
          ? new Response(JSON.stringify({ success: true, hostname: 'localhost', action: 'report' }))
          : upstream(url, init),
      ),
    );
    expect((await call('/reports', 'POST', payload())).status).toBe(400);
    fixture.env.REPORTS_ALLOW_LOCALHOST = 'true';
    expect((await call('/reports', 'POST', payload())).status).toBe(201);
  });
  it('keeps editor and moderation identities out of reporter receipt bodies', async () => {
    for (const reporter of [undefined, 5]) {
      const input = payload(),
        sent = await call('/reports', 'POST', input, reporter),
        { id } = (await sent.json()) as { id: string };
      expect(
        (await call(`/reports/${id}/action`, 'POST', { action: 'claim', expected_version: 1 }, 2))
          .status,
      ).toBe(200);
      const view = await call(
        `/reports/r/${id}/view`,
        'POST',
        { secret: input.withdraw_secret },
        reporter,
      );
      expect(view.status).toBe(200);
      const text = await view.text();
      for (const field of [
        'actor_id',
        'actor_login',
        'claimed_by',
        'fixed_by',
        'reporter_history',
        'duplicate_of',
        'possible_duplicate_of',
        'user2',
        'events',
      ])
        expect(text).not.toContain(field);
      expect(JSON.parse(text)).toHaveProperty('notes');
    }
  });
  it('bounds failed human checks and avoids repeated GitHub lookups for null-role submitters', async () => {
    const upstream = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        String(url).includes('siteverify')
          ? new Response(JSON.stringify({ success: false }))
          : upstream(url, init),
      ),
    );
    const before = fixture.subrequests;
    for (let i = 0; i < 10; i++)
      expect((await call('/reports', 'POST', payload(), 5)).status).toBe(400);
    expect((await call('/reports', 'POST', payload(), 5)).status).toBe(429);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('siteverify')).length,
    ).toBe(10);
    expect(fixture.subrequests - before).toBeLessThanOrEqual(3);
    expect(
      await db.prepare("SELECT count FROM limits WHERE key LIKE 'attempt10m:%'").first(),
    ).toEqual({ count: 10 });
  });
  it('purges more than the designed daily report volume within one day and drains expired limit rows', async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500) INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) SELECT 'retention-'||x,123,123,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','other','private','anonymous','retention-'||x,'test',0,0 FROM n",
      )
      .run();
    await db.prepare("UPDATE reports SET status='spam'").run();
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<250) INSERT INTO limits SELECT 'expired-'||x,1,3,0 FROM n",
      )
      .run();
    await purgeReports(fixture.env);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 436 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM limits').first()).toEqual({ n: 0 });
    for (let hour = 1; hour < 8; hour++) await purgeReports(fixture.env);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tombstones').first()).toEqual({ n: 500 });
  });
  it.skipIf(!process.env.REPORTS_BUDGET)(
    'handler budget proxy',
    async () => {
      const rows: Record<string, unknown>[] = [];
      await reportBudgetCases(
        async (label, path, method = 'GET', data, id, extra = {}) => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.100',
            ...extra,
          };
          if (id)
            headers.Authorization = `Bearer ${await signToken({ purpose: 'session', id, login: `user${id}`, exp: Math.floor(Date.now() / 1000) + 3600 }, fixture.env.SESSION_SECRET)}`;
          const request = new Request(`https://api.example${path}`, {
            method,
            headers,
            ...(data === undefined
              ? {}
              : {
                  body: data instanceof Uint8Array ? Uint8Array.from(data) : JSON.stringify(data),
                }),
          });
          if (
            process.env.REPORTS_BUDGET_FILTER &&
            !new RegExp(process.env.REPORTS_BUDGET_FILTER).test(label)
          )
            return worker.fetch(request, fixture.env, { waitUntil() {} });
          const before = vi.mocked(globalThis.fetch).mock.calls.length;
          const result = await reportBudget(request, fixture.env, { waitUntil() {} });
          const network = vi.mocked(globalThis.fetch).mock.calls.length - before;
          rows.push({
            route: label,
            status: result.response.status,
            wall_ms: result.wallMs,
            awaited_d1_ms: result.dbMs,
            handler_proxy_ms: result.handlerMs,
            subrequests: network + result.dbCalls,
            d1_calls: result.dbCalls,
            network_calls: network,
          });
          return result.response;
        },
        async (query) => {
          await db.prepare(query).run();
        },
      );
      const output = {
        label: 'proxy; real CPU verified after deploy',
        runtime: 'Node handler; getPlatformProxy local D1',
        rows,
      };
      if (process.env.REPORTS_BUDGET_FILTER && process.env.REPORTS_BUDGET_OUTPUT)
        output.rows = mergeBudgetRows(
          (
            JSON.parse(readFileSync(process.env.REPORTS_BUDGET_OUTPUT, 'utf8')) as {
              rows: Record<string, unknown>[];
            }
          ).rows,
          rows,
        );
      console.log(JSON.stringify(output));
      if (process.env.REPORTS_BUDGET_OUTPUT)
        writeFileSync(process.env.REPORTS_BUDGET_OUTPUT, JSON.stringify(output, null, 2));
      expect(rows.every((r) => Number(r.status) < 400)).toBe(true);
    },
    60_000,
  );
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
  it('enforces the global ceiling atomically, exempts role holders, and prechecks before Turnstile', async () => {
    const day = Math.floor(Date.now() / 86400000);
    await db
      .prepare('INSERT INTO limits VALUES(?,499,500,?)')
      .bind(`global:${day}`, (day + 1) * 86400)
      .run();
    const sent = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        call('/reports', 'POST', payload(), undefined, `192.0.2.${i + 10}`),
      ),
    );
    expect(sent.map((r) => r.status).sort()).toEqual([201, 503, 503]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).toEqual({ n: 1 });
    const before = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes('siteverify')).length;
    expect((await call('/reports', 'POST', payload())).status).toBe(503);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('siteverify')).length,
    ).toBe(before);
    expect((await call('/reports', 'POST', payload(), 1)).status).toBe(201);
  });
  it('scopes receipts to the reporter or a role with access and rejects stale action versions', async () => {
    const response = await call('/reports', 'POST', payload(), 5),
      { id } = (await response.json()) as { id: string };
    expect((await call(`/reports/r/${id}/view`, 'POST', {}, 6)).status).toBe(403);
    expect(
      (await call(`/reports/r/${id}/view`, 'POST', { secret: 'a'.repeat(43) }, 6)).status,
    ).toBe(403);
    expect((await call(`/reports/r/${id}/view`, 'POST', {}, 4)).status).toBe(403);
    expect((await call(`/reports/r/${id}/view`, 'POST', {}, 3)).status).toBe(200);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'triage', expected_version: 1 }, 2))
        .status,
    ).toBe(200);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'close', expected_version: 1 }, 2))
        .status,
    ).toBe(409);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'reopen', expected_version: 2 }, 2))
        .status,
    ).toBe(409);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'spam', expected_version: 2 }, 2))
        .status,
    ).toBe(403);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'close', expected_version: 2 }, 3))
        .status,
    ).toBe(200);
    expect(
      (await call(`/reports/${id}/action`, 'POST', { action: 'reopen', expected_version: 3 }, 3))
        .status,
    ).toBe(200);
  });
  it('invalidates a 304 after deleting the older of equal-timestamp reports', async () => {
    const a = await call('/reports', 'POST', payload()),
      b = await call('/reports', 'POST', payload());
    expect(b.status).toBe(201);
    const { id } = (await a.json()) as { id: string };
    await db.prepare('UPDATE reports SET updated_at=100').run();
    const before = await call('/reports/index', 'GET', undefined, 1),
      etag = before.headers.get('ETag')!;
    expect(
      (await call('/reports/index', 'GET', undefined, 1, '192.0.2.1', { 'If-None-Match': etag }))
        .status,
    ).toBe(304);
    // Cross-origin reads keep the route's ETag exposure next to the Worker-wide Date.
    const origin = { Origin: fixture.env.SITE_ORIGIN };
    for (const [extra, status] of [
      [origin, 200],
      [{ ...origin, 'If-None-Match': etag }, 304],
    ] as const) {
      const cors = await call('/reports/index', 'GET', undefined, 1, '192.0.2.1', extra);
      expect(cors.status).toBe(status);
      expect(cors.headers.get('Access-Control-Expose-Headers')).toBe('ETag, Date');
    }
    expect((await call(`/reports/${id}`, 'DELETE', undefined, 1)).status).toBe(200);
    const after = await call('/reports/index', 'GET', undefined, 1, '192.0.2.1', {
      'If-None-Match': etag,
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ open: { 123: { en: 1 } } });
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
  it('reapplies exported deletion and withdrawal privacy state to both restored databases', async () => {
    const a = payload(),
      b = payload();
    const deleted = ((await (await call('/reports', 'POST', a)).json()) as { id: string }).id;
    const withdrawn = ((await (await call('/reports', 'POST', b, 5)).json()) as { id: string }).id;
    const moderated = (
      (await (await call('/reports', 'POST', payload(), 5)).json()) as { id: string }
    ).id;
    await db.prepare('UPDATE reports SET files_count=1,files_bytes=64').run();
    const snapshots = (
      await db.prepare('SELECT * FROM reports').all<Record<string, string | number | null>>()
    ).results;
    const notes = (
      await db.prepare('SELECT * FROM notes').all<Record<string, string | number | null>>()
    ).results;
    for (const id of [deleted, withdrawn, moderated])
      await files
        .prepare("INSERT INTO files VALUES(?,1,5,'image/jpeg',64,'test',0,unhex(?))")
        .bind(id, Buffer.from(reportJpegFixture()).toString('hex'))
        .run();
    expect((await call(`/reports/${deleted}`, 'DELETE', undefined, 1)).status).toBe(200);
    expect((await call(`/reports/r/${withdrawn}/withdraw`, 'POST', {}, 5)).status).toBe(200);
    expect(
      (
        await call(
          `/reports/${moderated}/action`,
          'POST',
          { action: 'spam', expected_version: 1 },
          1,
        )
      ).status,
    ).toBe(200);
    const erased = (await db.prepare('SELECT id FROM tombstones').all<{ id: string }>()).results;
    const marker = (await db
      .prepare("SELECT value FROM meta WHERE key='marker_rev'")
      .first<{ value: string }>())!.value;
    const redacted = (
      await db.prepare("SELECT id FROM reports WHERE status='withdrawn'").all<{ id: string }>()
    ).results;
    const fenced = (
      await files.prepare('SELECT report_id AS id FROM files_closed').all<{ id: string }>()
    ).results;
    await db.prepare('DELETE FROM reports').run();
    await files.prepare('DELETE FROM files_closed').run();
    for (const row of snapshots)
      await db
        .prepare(
          `INSERT INTO reports(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .bind(...Object.values(row))
        .run();
    for (const row of notes)
      await db
        .prepare(
          `INSERT INTO notes(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .bind(...Object.values(row))
        .run();
    for (const id of [deleted, withdrawn, moderated])
      await files
        .prepare("INSERT INTO files VALUES(?,1,5,'image/jpeg',64,'test',0,unhex(?))")
        .bind(id, Buffer.from(reportJpegFixture()).toString('hex'))
        .run();
    // Runbook: files first for the union, then tombstone deletes and withdrawal
    // redaction in reports. These operations are idempotent on repeated restore.
    await db.prepare("UPDATE meta SET value='0' WHERE key='marker_rev'").run();
    for (let pass = 0; pass < 2; pass++) {
      for (const { id } of [...erased, ...redacted, ...fenced])
        await files.batch([
          files.prepare('INSERT OR IGNORE INTO files_closed VALUES(?)').bind(id),
          files.prepare('DELETE FROM files WHERE report_id=?').bind(id),
        ]);
      for (const { id } of fenced)
        await db
          .prepare(
            'UPDATE reports SET files_count=0,files_bytes=0,files_epoch=files_epoch+1 WHERE id=?',
          )
          .bind(id)
          .run();
      for (const { id } of erased)
        await db.prepare('DELETE FROM reports WHERE id=?').bind(id).run();
      for (const { id } of redacted)
        await db.batch([
          db
            .prepare(
              "UPDATE reports SET status='withdrawn',note='',source_url=NULL,src=NULL,links='[]',reporter_login=NULL,closed_note=NULL,files_count=0,files_bytes=0,files_epoch=files_epoch+1 WHERE id=?",
            )
            .bind(id),
          db.prepare('DELETE FROM notes WHERE report_id=?').bind(id),
          db.prepare('DELETE FROM events WHERE report_id=?').bind(id),
        ]);
      await db
        .prepare("UPDATE meta SET value=MAX(CAST(value AS INTEGER),?)+1 WHERE key='marker_rev'")
        .bind(Number(marker))
        .run();
    }
    expect(
      await db.prepare('SELECT note,status FROM reports WHERE id=?').bind(withdrawn).first(),
    ).toEqual({
      note: '',
      status: 'withdrawn',
    });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE report_id=?').bind(withdrawn).first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare('SELECT files_count,files_bytes FROM reports WHERE id=?')
        .bind(moderated)
        .first(),
    ).toEqual({ files_count: 0, files_bytes: 0 });
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
    await expect(
      files
        .prepare("INSERT INTO files VALUES(?,1,5,'image/jpeg',64,'test',0,unhex(?))")
        .bind(withdrawn, Buffer.from(reportJpegFixture()).toString('hex'))
        .run(),
    ).rejects.toThrow('REPORT_FILES_CLOSED');
    expect(
      Number(
        (await db
          .prepare("SELECT value FROM meta WHERE key='marker_rev'")
          .first<{ value: string }>())!.value,
      ),
    ).toBeGreaterThan(Number(marker));
    const role = await call('/reports?hash=123&lang=en', 'GET', undefined, 1);
    const body = (await role.json()) as {
      id: string;
      reporter_id: number | null;
      reporter_history: unknown;
    }[];
    expect(body.find((r) => r.id === withdrawn)).toMatchObject({
      reporter_id: null,
      reporter_history: null,
    });
  });
  it('serialises concurrent uploads at three, scopes file reads, and removes files on withdrawal', async () => {
    const input = payload(),
      response = await call('/reports', 'POST', input, 5),
      { id } = (await response.json()) as { id: string };
    const bytes = reportJpegFixture();
    const token = await signToken(
      { purpose: 'session', id: 5, login: 'user5', exp: Math.floor(Date.now() / 1000) + 3600 },
      fixture.env.SESSION_SECRET,
    );
    const upload = () =>
      worker.fetch(
        new Request(`https://api.example/reports/${id}/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'image/jpeg',
            'X-Report-Request-Id': input.request_id,
          },
          body: bytes,
        }),
        fixture.env,
        { waitUntil() {} },
      );
    const results = await Promise.all(Array.from({ length: 4 }, upload));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 429]);
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 3 });
    expect((await call(`/reports/${id}/files/1`, 'GET', undefined, 4)).status).toBe(403);
    const editorFile = await call(`/reports/${id}/files/1`, 'GET', undefined, 2);
    expect(editorFile.status).toBe(200);
    expect(editorFile.headers.get('Vary')).toContain('Authorization');
    expect((await call(`/reports/${id}/files/1`, 'GET', undefined, 5)).status).toBe(200);
    expect((await call(`/reports/r/${id}/withdraw`, 'POST', {}, 5)).status).toBe(200);
    expect(await files.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
  });
  it('bounds D1 rows read independently of 10,000 retained reports and 50,000 notes', async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,status,category,note,trust,request_id,payload_hash,created_at,updated_at) SELECT 'history-'||x,123,123,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','closed','other','private','anonymous','history-'||x,'test',x,x FROM n",
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5) INSERT INTO notes(report_id,n,category,text,exact,prefix,suffix,start,end,line,whole) SELECT r.id,n.x,'other','note','x','','',0,1,0,0 FROM reports r CROSS JOIN n",
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO open_counts SELECT 100000+x,'en',0 FROM n",
      )
      .run();
    const scans: { query: string; rows_read: number }[] = [];
    const originals = new WeakMap<ReportStatement, { statement: ReportStatement; query: string }>();
    const capture = (query: string, rows: number | undefined) => {
      expect(rows).toBeTypeOf('number');
      scans.push({ query, rows_read: rows! });
    };
    const wrap = (statement: ReportStatement, query: string): ReportStatement => {
      const result: ReportStatement = {
        bind(...args) {
          return wrap(statement.bind(...args), query);
        },
        async first<T>() {
          const result = await statement.all<T>();
          capture(query, result.meta?.rows_read);
          return result.results[0] ?? null;
        },
        async all<T>() {
          const result = await statement.all<T>();
          capture(query, result.meta?.rows_read);
          return result;
        },
        run() {
          return statement.run();
        },
      };
      originals.set(result, { statement, query });
      return result;
    };
    fixture.env.REPORTS_DB = {
      prepare(query) {
        return wrap(db.prepare(query), query);
      },
      async batch(statements) {
        const result = await db.batch(statements.map((s) => originals.get(s)!.statement));
        result.forEach((row, i) =>
          capture(originals.get(statements[i])!.query, row.meta.rows_read),
        );
        return result;
      },
      exec(query) {
        return db.exec(query);
      },
    };
    expect((await call('/reports/index', 'GET', undefined, 1)).status).toBe(200);
    const list = await call('/reports/list?status=closed', 'GET', undefined, 1);
    expect(await list.json()).toMatchObject({ rows: [{ reports: 10000 }] });
    const body = await call('/reports?hash=123&lang=en', 'GET', undefined, 1);
    const reports = (await body.json()) as { notes: unknown[] }[];
    expect(reports).toHaveLength(200);
    expect(reports.every((r) => r.notes.length === 5)).toBe(true);
    await purgeReports(fixture.env);
    const marker = scans.filter((s) => s.query.includes('FROM open_counts'));
    const grouped = scans.filter((s) => s.query.includes('FROM report_rollups'));
    const owner = scans.filter((s) => s.query.startsWith('SELECT * FROM reports WHERE owner_hash'));
    const noteReads = scans.filter((s) => s.query.startsWith('SELECT n.* FROM notes'));
    const reporterReads = scans.filter((s) => s.query.startsWith('SELECT * FROM reporters'));
    const purge = scans.filter((s) =>
      s.query.startsWith('SELECT id,status,version,updated_at FROM reports'),
    );
    expect(marker).toHaveLength(1);
    expect(marker[0].rows_read).toBeLessThan(10);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].rows_read).toBeLessThan(20);
    expect(owner).toHaveLength(1);
    expect(owner[0].rows_read).toBeLessThanOrEqual(500);
    expect(noteReads).toHaveLength(1);
    expect(noteReads[0].rows_read).toBeLessThanOrEqual(3500);
    expect(reporterReads).toHaveLength(1);
    expect(reporterReads[0].rows_read).toBeLessThanOrEqual(500);
    expect(purge).toHaveLength(8);
    expect(purge.reduce((n, s) => n + s.rows_read, 0)).toBeLessThanOrEqual(1024);
    if (process.env.REPORTS_QUERY_EVIDENCE_OUTPUT)
      writeFileSync(
        process.env.REPORTS_QUERY_EVIDENCE_OUTPUT,
        JSON.stringify(
          { reports: 10000, notes: 50000, inactive_marker_rows: 10000, scans },
          null,
          2,
        ),
      );
    fixture.env.REPORTS_DB = db;
  }, 60_000);
});
it('normalises IPv6 /64 equivalents', () => {
  expect(reportIP('2001:0db8:0001:0002:abcd::1')).toBe(reportIP('2001:db8:1:2::2'));
  expect(reportIP('::1')).toBe('0:0:0:0');
});
it('refuses non-image uploads', () =>
  expect(() => reportImage(new TextEncoder().encode('<svg/>'))).toThrow());
