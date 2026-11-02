import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings, type SyncedSettings } from '@clarity/core';
import { Fixture, makePrivateKey, sha } from './fixture.js';
import worker from '../src/index.js';
import {
  coarseDate,
  decryptEntry,
  encryptEntry,
  settingsFileId,
  settingsKey,
  type SettingsEntry,
} from '../src/settings.js';

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

const mine: SyncedSettings = {
  ...defaultSyncedSettings,
  dateFormat: 'iso',
  timeZone: 'Europe/Berlin',
  markupToolbar: 'open',
};
const revisionA = 'a'.repeat(32);
type Store = { v: 1; entries: Record<string, SettingsEntry> };
const store = () =>
  fixture.settingsHead
    ? (fixture.snapshots.get(fixture.settingsHead)?.['settings.json'] as Store | undefined)
    : undefined;
const settingsCommits = () =>
  fixture.commits.filter((commit) => commit.message === 'Update synced settings');

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

  it('uses fresh nonces and one fixed ciphertext size for every entry', async () => {
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
    expect(short.ct.length).toBe(a.ct.length);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(await settingsFileId(secret, 1));
    expect(id).not.toBe(await settingsFileId(secret, 2));
  });

  it('rounds commit dates down to the UTC hour', () => {
    expect(coarseDate(Date.parse('2026-11-02T17:42:13.512Z'))).toBe('2026-11-02T17:00:00Z');
  });
});

describe('/settings endpoint', () => {
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

  it('writes to its own branch, never the data branch, creating it on first sync', async () => {
    const dataHead = fixture.dataHead;
    expect(await read()).toEqual({ settings: null, revision: null, unreadable: false });
    await synced(await put(mine, null));
    const first = fixture.settingsHead;
    expect(first).not.toBeNull();
    expect(settingsCommits()[0].parents).toEqual([]);
    await synced(await put(mine, null, 2));
    expect(settingsCommits()[1].parents).toEqual([first]);
    expect(fixture.dataHead).toBe(dataHead);
  });

  it('allows every role, including translators', async () => {
    for (const id of [1, 2, 3, 4]) await synced(await put(mine, null, id));
    expect(Object.keys(store()!.entries)).toHaveLength(4);
  });

  it('stores only fixed-size ciphertext under opaque ids, credited to the bot at a coarse time', async () => {
    const { revision } = await synced(await put(mine, null));
    const saved = store()!;
    const ids = Object.keys(saved.entries);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
    const bytes = `${JSON.stringify(saved)}\n${JSON.stringify(settingsCommits()[0])}`;
    for (const leak of ['alice', '"1"', 'Europe/Berlin', 'iso', 'markupToolbar', revision]) {
      expect(bytes).not.toContain(leak);
    }
    const bot = { name: 'clarity-test[bot]', email: 'clarity-test[bot]@users.noreply.github.com' };
    const commit = settingsCommits()[0] as {
      author: { date: string };
      committer: { date: string };
    };
    expect(commit).toMatchObject({ author: bot, committer: bot });
    expect(commit.author.date).toMatch(/T\d\d:00:00Z$/);
    expect(commit.committer.date).toBe(commit.author.date);
    expect(await read()).toEqual({ settings: mine, revision, unreadable: false });
  });

  it('re-encrypts every entry on every sync, so a commit does not reveal whose settings changed', async () => {
    const alice = await synced(await put(mine, null, 1));
    const bob = await synced(await put(defaultSyncedSettings, null, 2));
    const before = store()!.entries;
    await synced(await put({ ...defaultSyncedSettings, timeDisplay: 'date' }, bob.revision, 2));
    const after = store()!.entries;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const id of Object.keys(before)) {
      expect(after[id].iv).not.toBe(before[id].iv);
      expect(after[id].ct).not.toBe(before[id].ct);
      expect(after[id].ct.length).toBe(before[id].ct.length);
    }
    // Alice's settings and revision are untouched by Bob's sync.
    expect(await read(1)).toEqual({ settings: mine, revision: alice.revision, unreadable: false });
  });

  it('returns 409 with the stored copy when another device synced first', async () => {
    const first = await synced(await put(mine, null));
    const stale = await put({ ...mine, dateFormat: 'mdy' }, null);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ settings: mine, revision: first.revision });
    // Other users' syncs rewrite every entry but never change this user's revision.
    await synced(await put(mine, null, 2));
    await synced(await put({ ...mine, dateFormat: 'mdy' }, first.revision));
    expect(settingsCommits()).toHaveLength(3);
  });

  it('skips no-op writes and retries when the settings branch moves', async () => {
    const first = await synced(await put(mine, null));
    expect(await (await put(mine, first.revision)).json()).toEqual(first);
    expect(settingsCommits()).toHaveLength(1);
    fixture.settingsRaces = 1;
    await synced(await put({ ...mine, timeDisplay: 'relative' }, first.revision));
    expect(settingsCommits()).toHaveLength(3);
  });

  it('retries when two first syncs race to create the branch', async () => {
    fixture.settingsRaces = 1;
    await synced(await put(mine, null));
    expect(fixture.settingsHead).not.toBeNull();
  });

  it('reports a tampered entry as unreadable to its owner, who can overwrite it; others drop it', async () => {
    await synced(await put(mine, null, 1));
    const bob = await synced(await put(mine, null, 2));
    const saved = store()!;
    const secret = fixture.env.SESSION_SECRET;
    const aliceId = await settingsFileId(secret, 1);
    const commit = sha(fixture.sequence++);
    fixture.snapshots.set(commit, {
      'settings.json': {
        ...saved,
        entries: {
          ...saved.entries,
          [aliceId]: { ...saved.entries[aliceId], iv: 'AAAAAAAAAAAAAAAA' },
        },
      },
    });
    fixture.settingsHead = commit;
    expect(await read(1)).toEqual({ settings: null, revision: null, unreadable: true });
    expect((await read(2)).settings).toEqual(mine);
    // Bob's next sync re-encrypts only readable entries; Alice can then start over.
    await synced(await put({ ...mine, dateFormat: 'dmy' }, bob.revision, 2));
    expect(Object.keys(store()!.entries)).toEqual([await settingsFileId(secret, 2)]);
    await synced(await put(mine, null, 1));
    expect(Object.keys(store()!.entries)).toHaveLength(2);
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
