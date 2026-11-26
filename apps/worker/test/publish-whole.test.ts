import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  publishAccountPath,
  publishIntentDigest,
  publishMonth,
  type PublishPayload,
} from '@clarity/core';
import { Fixture, makePrivateKey } from './fixture.js';
import type { SettingsDatabase, SettingsStatement } from '../src/settings.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: true } }));

const A = '01K95H00000000000000000001';
const B = '01K95H00000000000000000002';
const requestPath = (id = A) => `publish/requests/${id}.json`;
const logPath = (id = A) => `publish/log/${publishMonth(id)}/${id}.json`;
const time = [...A.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
const pin = { capabilities: ['clearedRemovals', 'inactiveMoves', 'wholeSelectionV1'] };
const digest = (n: number) => n.toString(16).padStart(64, '0');
/** A whole selection: rows are never read at admission, so any reviewed digests do. */
const body = (rows: number, id = A) => {
  const hashes = Array.from({ length: rows }, (_, i) => 1000 + i);
  return {
    opId: id,
    hashes,
    expected: Object.fromEntries(hashes.map((hash) => [hash, digest(hash)])),
    selection: 'whole' as const,
  };
};
let appKey: string;
let f: Fixture;
let db: DatabaseSync;
const binding: SettingsDatabase = {
  prepare(sql) {
    let values: (string | number | null)[] = [];
    const statement: SettingsStatement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...values) ?? null) as T | null;
      },
      async run() {
        return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
      },
    };
    return statement;
  },
};
beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: time });
  f = new Fixture(appKey);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  f.moveData({ '.publisher/PIN': pin });
  db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(new URL('../migrations/settings/0004_publish_acks.sql', import.meta.url), 'utf8'),
  );
  f.env.SETTINGS_DB = binding;
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([1, 148, 500])(
  'admits %s rows in one commit with the account entry, reading no row',
  async (rows) => {
    const before = f.subrequests;
    const cpu = process.cpuUsage();
    const response = await f.request('/publish', 'POST', body(rows), 2);
    const used = process.cpuUsage(cpu);
    expect(response.status, await response.clone().text()).toBe(202);
    // Installation token, one GraphQL snapshot, then tree, commit, and ref: no row reads.
    expect(f.subrequests - before).toBe(5);
    expect(f.commits).toHaveLength(1);
    const files = f.current();
    const envelope = files[requestPath()] as { payload: string };
    const payload = JSON.parse(envelope.payload) as PublishPayload;
    expect(payload).toMatchObject({ selection: 'whole', requester: { id: 2 } });
    expect(payload.hashes).toHaveLength(rows);
    expect(payload.intentDigest).toBe(await publishIntentDigest(payload));
    expect(files[publishAccountPath(2)]).toEqual({
      entries: [
        {
          opId: A,
          createdAt: payload.createdAt,
          rows,
          globals: 0,
          status: 'pending',
          held: 0,
          updatedAt: payload.createdAt,
        },
      ],
    });
    // Local process CPU proxy of the whole route (Node, not the Workers isolate).
    console.log(
      `whole-selection admission ${rows} rows: ${((used.user + used.system) / 1000).toFixed(1)} ms process CPU, ${f.subrequests - before} subrequests`,
    );
  },
);

it('refuses before any write while the installed publisher lacks the capability', async () => {
  f.moveData({ '.publisher/PIN': { capabilities: ['clearedRemovals'] } });
  const response = await f.request('/publish', 'POST', body(3), 2);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    details: { code: 'whole-selection-unavailable' },
  });
  expect(f.commits).toHaveLength(0);
});

it('replays the same id and body without writing, and refuses another body under that id', async () => {
  expect((await f.request('/publish', 'POST', body(3), 2)).status).toBe(202);
  const head = f.dataHead;
  vi.setSystemTime(time + 3 * 86_400_000);
  expect((await f.request('/publish', 'POST', body(3), 2)).status).toBe(202);
  expect(f.dataHead).toBe(head);
  expect((await f.request('/publish', 'POST', body(4), 2)).status).toBe(409);
  const ordinary = { ...body(3), selection: undefined };
  expect((await f.request('/publish', 'POST', ordinary, 2)).status).toBe(409);
  // The terminal log answers a replay with its result, held rows included.
  const result = {
    status: 'done',
    held: [{ hash: 1001, code: 'changed', reason: 'Saved text changed after review.' }],
  };
  const files = { ...f.current() };
  const request = files[requestPath()];
  delete files[requestPath()];
  f.moveData({
    ...files,
    [requestPath()]: undefined,
    [logPath()]: {
      request,
      intentDigest: JSON.parse((request as { payload: string }).payload).intentDigest,
      result,
    },
  });
  const replay = await f.request('/publish', 'POST', body(3), 2);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ opId: A, result });
  const status = await f.request(`/publish/status?opId=${A}`, 'GET', undefined, 2);
  expect(await status.json()).toEqual({
    operations: [{ opId: A, status: 'done', held: result.held }],
  });
});

it('refuses trials and translators, and the shared text fence still applies', async () => {
  expect((await f.request('/publish', 'POST', body(1), 3)).status).toBe(403);
  expect((await f.request('/publish', 'POST', body(1), 4)).status).toBe(403);
  f.moveData({ 'globals/layout.json': { version: 1 } });
  const fenced = await f.request('/publish', 'POST', body(1), 2);
  expect(fenced.status).toBe(409);
  expect(f.commits).toHaveLength(0);
});

it('keeps the newest 50 account entries', async () => {
  f.moveData({
    [publishAccountPath(2)]: {
      entries: Array.from({ length: 50 }, (_, i) => ({
        opId: `01K95G${String(i).padStart(20, '0')}`,
        createdAt: '2026-11-01T00:00:00.000Z',
        rows: 1,
        globals: 0,
        status: 'done',
        held: 0,
        updatedAt: '2026-11-01T00:00:00.000Z',
      })),
    },
  });
  expect((await f.request('/publish', 'POST', body(2), 2)).status).toBe(202);
  const { entries } = f.current()[publishAccountPath(2)] as { entries: { opId: string }[] };
  expect(entries).toHaveLength(50);
  expect(entries.at(-1)!.opId).toBe(A);
  expect(entries[0]!.opId).toBe(`01K95G${'1'.padStart(20, '0')}`);
});

it('lists only the own account index with its acknowledgments, failing open without D1', async () => {
  expect((await f.request('/publish', 'POST', body(2), 2)).status).toBe(202);
  expect((await f.request('/publish', 'POST', body(2, B), 1)).status).toBe(202);
  const mine = async (id: number) =>
    (await (await f.request('/publish/mine', 'GET', undefined, id)).json()) as {
      entries: { opId: string }[];
      acknowledged: string[] | null;
    };
  expect((await mine(2)).entries.map(({ opId }) => opId)).toEqual([A]);
  expect((await mine(2)).acknowledged).toEqual([]);
  expect((await f.request('/publish/ack', 'POST', { opId: A }, 2)).status).toBe(200);
  expect((await f.request('/publish/ack', 'POST', { opId: A }, 2)).status).toBe(200);
  expect((await mine(2)).acknowledged).toEqual([A]);
  expect((await mine(1)).acknowledged).toEqual([]);
  // A former editor (now a trial) still reads its own redacted index.
  expect((await mine(3)).entries).toEqual([]);
  delete f.env.SETTINGS_DB;
  expect((await mine(2)).acknowledged).toBeNull();
  expect((await f.request('/publish/ack', 'POST', { opId: 'nope' }, 2)).status).toBe(400);
});

// Local process-CPU proxy (Node, includes the fixture's simulated GitHub and session checks, so an
// upper bound of the route's own work). PUBLISH_CPU=1 to run; compares with today's accepted
// ordinary 50-row part.
it.runIf(process.env.PUBLISH_CPU)(
  'measures admission CPU against the ordinary 50-row part',
  async () => {
    const rounds = 200;
    const measure = async (make: (i: number) => unknown) => {
      // Windows process CPU ticks at about 15.6 ms: report the mean over all rounds.
      const values = Array.from({ length: rounds }, (_, i) => make(i));
      const start = process.cpuUsage();
      for (const value of values) {
        const response = await f.request('/publish', 'POST', value, 2);
        if (response.status !== 202) throw new Error(await response.text());
      }
      const used = process.cpuUsage(start);
      return { meanMs: Number(((used.user + used.system) / 1000 / rounds).toFixed(2)) };
    };
    const id = (i: number) => `01K95H${String(i + 100).padStart(20, '0')}`;
    const report: Record<string, unknown> = {};
    for (const rows of [148, 500]) {
      const before = f.subrequests;
      report[`whole ${rows}`] = {
        ...(await measure((i) => ({ ...body(rows, id(i + rows)) }))),
        subrequests: (f.subrequests - before) / rounds,
      };
    }
    const { tooltip } = await import('./fixture.js');
    const { publishableHash } = await import('@clarity/core');
    const documents = Array.from({ length: 50 }, (_, i) => ({
      ...tooltip(`row ${i}`),
      hash: 2000 + i,
    }));
    f.moveData(Object.fromEntries(documents.map((d) => [`tooltips/${d.hash}.json`, d])));
    const expected = Object.fromEntries(
      await Promise.all(documents.map(async (d) => [d.hash, await publishableHash(d, f.aliases)])),
    );
    const before = f.subrequests;
    report['ordinary 50'] = {
      ...(await measure((i) => ({
        opId: id(i + 900),
        hashes: documents.map(({ hash }) => hash),
        expected,
      }))),
      subrequests: (f.subrequests - before) / rounds,
    };
    console.log(`publish admission CPU proxy (ms, ${rounds} rounds): ${JSON.stringify(report)}`);
  },
);
