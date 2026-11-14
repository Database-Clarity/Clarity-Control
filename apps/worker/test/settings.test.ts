import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings, type SyncedSettings } from '@clarity/core';
import { Fixture, makePrivateKey } from './fixture.js';
import worker from '../src/index.js';
import {
  decryptEntry,
  encryptEntry,
  settingsFileId,
  settingsKey,
  type SettingsDatabase,
  type SettingsStatement,
} from '../src/settings.js';

let key: string;
let fixture: Fixture;
let db: DatabaseSync;
let beforeWrite: (() => Promise<void>) | undefined;
const migration = readFileSync(
  new URL('../migrations/settings/0001_user_settings.sql', import.meta.url),
  'utf8',
);
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
        const hook = beforeWrite;
        beforeWrite = undefined;
        await hook?.();
        return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
      },
    };
    return statement;
  },
};
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  db = new DatabaseSync(':memory:');
  db.exec(migration);
  fixture.env.SETTINGS_DB = binding;
  beforeWrite = undefined;
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

const mine: SyncedSettings = {
  ...defaultSyncedSettings,
  dateFormat: 'iso',
  timeZone: 'Europe/Berlin',
  markupToolbar: 'open',
};
const revisionA = 'a'.repeat(32);
async function put(settings: unknown, revision: string | null, id = 1) {
  return fixture.request('/settings', 'PUT', { settings, revision }, id);
}
async function synced(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as { settings: SyncedSettings; revision: string };
}
async function read(id = 1) {
  return (await (await fixture.request('/settings', 'GET', undefined, id)).json()) as {
    settings: SyncedSettings | null;
    revision: string | null;
    unreadable: boolean;
  };
}

describe('synced settings crypto', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  it('round-trips and rejects tampering, swapped entries and other secrets', async () => {
    const serverKey = await settingsKey(secret);
    const id = await settingsFileId(secret, 1);
    const plain = { settings: mine, revision: revisionA };
    const entry = await encryptEntry(serverKey, id, plain);
    expect(await decryptEntry(serverKey, id, entry)).toEqual(plain);
    const flipped = entry.ct.at(-2) === 'A' ? 'B' : 'A';
    const tampered = { ...entry, ct: `${entry.ct.slice(0, -2)}${flipped}${entry.ct.at(-1)}` };
    expect(await decryptEntry(serverKey, id, tampered)).toBeNull();
    // An entry moved under another user's id fails authentication (id is associated data).
    expect(await decryptEntry(serverKey, await settingsFileId(secret, 2), entry)).toBeNull();
    expect(await decryptEntry(await settingsKey(`${secret}x`), id, entry)).toBeNull();
    expect(await decryptEntry(serverKey, id, { ...entry, extra: 1 })).toBeNull();
  });

  it('uses fresh nonces and unpadded ciphertext for every entry', async () => {
    const serverKey = await settingsKey(secret);
    const id = await settingsFileId(secret, 1);
    const long = { ...mine, timeZone: 'America/Argentina/ComodRivadavia' };
    const a = await encryptEntry(serverKey, id, { settings: long, revision: revisionA });
    const b = await encryptEntry(serverKey, id, { settings: long, revision: revisionA });
    const short = await encryptEntry(serverKey, id, {
      settings: defaultSyncedSettings,
      revision: revisionA,
    });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(short.ct.length).toBeLessThan(a.ct.length);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(await settingsFileId(secret, 1));
    expect(id).not.toBe(await settingsFileId(secret, 2));
  });

  it('decrypts pre-migration entries with defaults, and keeps the expanded ciphertext under the body limit', async () => {
    const serverKey = await settingsKey(secret);
    const id = await settingsFileId(secret, 1);
    const old = Object.fromEntries(
      Object.entries(mine).filter(
        ([key]) =>
          ![
            'editorFont',
            'suggestAccept',
            'symbolReveal',
            'finderWheel',
            'worklistStepping',
          ].includes(key),
      ),
    );
    // Model an entry encrypted by the old Worker before these five keys existed.
    const entry = await encryptEntry(serverKey, id, {
      settings: old as SyncedSettings,
      revision: revisionA,
    });
    expect((await decryptEntry(serverKey, id, entry))?.settings).toEqual(mine);
    const expanded = await encryptEntry(serverKey, id, {
      settings: {
        ...mine,
        editorFont: 'jetbrains-mono',
        timeZone: 'America/Argentina/ComodRivadavia',
      },
      revision: revisionA,
    });
    expect(expanded.ct.length).toBeLessThan(1024);
    expect(JSON.stringify(expanded).length).toBeLessThan(4096);
    expect(JSON.stringify({ settings: mine, revision: revisionA }).length).toBeLessThan(512);
  });
});

describe('/settings endpoint', () => {
  it('accepts old payloads without the five preferences and new payloads with them', async () => {
    const old = Object.fromEntries(
      Object.entries(mine).filter(
        ([key]) =>
          ![
            'editorFont',
            'suggestAccept',
            'symbolReveal',
            'finderWheel',
            'worklistStepping',
          ].includes(key),
      ),
    );
    const first = await synced(await put(old, null));
    expect(first.settings).toEqual(mine);
    const next = {
      ...mine,
      editorFont: 'fira-code',
      suggestAccept: 'tab',
      symbolReveal: 'caret',
      finderWheel: 'groups',
      worklistStepping: false,
    };
    expect((await synced(await put(next, first.revision))).settings).toEqual(next);
    expect((await read()).settings).toEqual(next);
    expect((await put({ ...next, unknown: true }, null)).status).toBe(400);
  });

  it('requires a session and an editing role', async () => {
    expect((await fixture.request('/settings', 'GET')).status).toBe(200);
    // User 5 has a valid session but no entry in config/permissions.json.
    expect((await fixture.request('/settings', 'GET', undefined, 5)).status).toBe(403);
    expect((await put(mine, null, 5)).status).toBe(403);
    const unsigned = await worker.fetch(
      new Request('https://api.example/settings', {
        headers: { Origin: fixture.env.SITE_ORIGIN },
      }),
      fixture.env,
      { waitUntil: () => undefined },
    );
    expect(unsigned.status).toBe(401);
    expect(fixture.commits).toHaveLength(0);
  });

  it('starts empty and stores only the caller row without GitHub storage requests', async () => {
    const head = fixture.dataHead;
    expect(await read()).toEqual({ settings: null, revision: null, unreadable: false });
    const first = await synced(await put(mine, null));
    expect(await read()).toEqual({ ...first, unreadable: false });
    const row = db.prepare('SELECT * FROM user_settings').get()!;
    expect(row.id).toBe(await settingsFileId(fixture.env.SESSION_SECRET, 1));
    expect(String(row.ct)).not.toContain('Europe/Berlin');
    expect(row.revision).toBe(first.revision);
    expect(row.updated_at).toEqual(expect.any(Number));
    expect(fixture.settingsHead).toBeNull();
    expect(fixture.dataHead).toBe(head);
    expect(fixture.commits).toHaveLength(0);
    // Only installation-token and fresh permission reads may reach GitHub.
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(
      calls.every((url) =>
        /access_tokens|git\/ref\/heads\/editor-data|contents\/config\/permissions.json/.test(url),
      ),
    ).toBe(true);
  });

  it('allows all editing roles and leaves other user rows untouched', async () => {
    for (const id of [1, 2, 3, 4]) await synced(await put(mine, null, id));
    expect(db.prepare('SELECT count(*) AS n FROM user_settings').get()?.n).toBe(4);
    const aliceId = await settingsFileId(fixture.env.SESSION_SECRET, 1);
    const alice = db.prepare('SELECT * FROM user_settings WHERE id=?').get(aliceId);
    const bob = await read(2);
    await synced(await put({ ...mine, dateFormat: 'mdy' }, bob.revision, 2));
    expect(db.prepare('SELECT * FROM user_settings WHERE id=?').get(aliceId)).toEqual(alice);
  });

  it('returns 409 with the stored copy for stale revisions and skips no-op writes', async () => {
    const first = await synced(await put(mine, null));
    const stale = await put({ ...mine, dateFormat: 'mdy' }, null);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject(first);
    const before = db.prepare('SELECT * FROM user_settings').get();
    expect(await synced(await put(mine, first.revision))).toEqual(first);
    expect(db.prepare('SELECT * FROM user_settings').get()).toEqual(before);
    await synced(await put({ ...mine, dateFormat: 'mdy' }, first.revision));
  });

  it.each([false, true])('does not lose concurrent writes (existing row: %s)', async (existing) => {
    const base = existing ? (await synced(await put(mine, null))).revision : null;
    let winner: Awaited<ReturnType<typeof synced>>;
    beforeWrite = async () => {
      winner = await synced(await put({ ...mine, dateFormat: 'mdy' }, base));
    };
    const loser = await put({ ...mine, timeDisplay: 'date' }, base);
    expect(loser.status).toBe(409);
    expect(await loser.json()).toMatchObject(winner!);
    expect(await read()).toEqual({ ...winner!, unreadable: false });
  });

  it('reports unreadable rows, isolates other users, and lets the owner repair safely', async () => {
    await synced(await put(mine, null));
    const aliceId = await settingsFileId(fixture.env.SESSION_SECRET, 1);
    db.prepare('UPDATE user_settings SET iv=? WHERE id=?').run('AAAAAAAAAAAAAAAA', aliceId);
    expect(await read()).toEqual({ settings: null, revision: null, unreadable: true });
    await synced(await put(mine, null, 2));
    expect((await read()).unreadable).toBe(true);
    await synced(await put(mine, null));
    expect((await read()).unreadable).toBe(false);
    db.prepare('UPDATE user_settings SET revision=? WHERE id=?').run('b'.repeat(32), aliceId);
    expect((await read()).unreadable).toBe(true);
  });

  it('returns unavailable when the D1 binding is absent', async () => {
    delete fixture.env.SETTINGS_DB;
    expect((await fixture.request('/settings', 'GET')).status).toBe(503);
  });

  it('validates the schema and limits the size', async () => {
    expect((await put({ ...mine, extra: true }, null)).status).toBe(400);
    expect((await put({ ...mine, timeZone: 'Mars/Olympus' }, null)).status).toBe(400);
    expect((await put(mine, 'not-a-revision')).status).toBe(400);
    const huge = await fixture.request('/settings', 'PUT', {
      settings: mine,
      revision: null,
      filler: 'x'.repeat(5000),
    });
    expect(huge.status).toBe(413);
    expect(fixture.commits).toHaveLength(0);
  });
});
