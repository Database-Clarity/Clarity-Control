import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings, type SyncedSettings } from '@clarity/core';
import { Fixture, makePrivateKey } from './fixture.js';
import { decryptSettings, encryptSettings, settingsFileId } from '../src/settings.js';

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
const settingsFiles = () =>
  Object.entries(fixture.current()).filter(([path]) => path.startsWith('user-settings/'));

async function put(settings: unknown, revision: string | null, id = 1) {
  return fixture.request('/settings', 'PUT', { settings, revision }, id);
}

describe('synced settings crypto', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  it('round-trips and rejects tampering, other users and other files', async () => {
    const id = await settingsFileId(secret, 1);
    const envelope = await encryptSettings(secret, 1, id, mine);
    expect(await decryptSettings(secret, 1, id, envelope)).toEqual(mine);
    const flipped = envelope.ct.at(-2) === 'A' ? 'B' : 'A';
    const tampered = {
      ...envelope,
      ct: `${envelope.ct.slice(0, -2)}${flipped}${envelope.ct.at(-1)}`,
    };
    expect(await decryptSettings(secret, 1, id, tampered)).toBeNull();
    expect(await decryptSettings(secret, 2, id, envelope)).toBeNull();
    expect(await decryptSettings(secret, 1, await settingsFileId(secret, 2), envelope)).toBeNull();
    expect(await decryptSettings(`${secret}x`, 1, id, envelope)).toBeNull();
    expect(await decryptSettings(secret, 1, id, { ...envelope, extra: 1 })).toBeNull();
  });
  it('uses a random nonce, pads sizes and derives distinct opaque ids', async () => {
    const id = await settingsFileId(secret, 1);
    const a = await encryptSettings(secret, 1, id, mine);
    const b = await encryptSettings(secret, 1, id, mine);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    const short = await encryptSettings(secret, 1, id, defaultSyncedSettings);
    expect(short.ct.length).toBe(a.ct.length);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(await settingsFileId(secret, 1));
    expect(id).not.toBe(await settingsFileId(secret, 2));
  });
});

describe('/settings endpoint', () => {
  it('requires a session and an editing role', async () => {
    expect((await fixture.request('/settings', 'GET')).status).toBe(200);
    // User 5 has a valid session but no entry in config/permissions.json.
    expect((await fixture.request('/settings', 'GET', undefined, 5)).status).toBe(403);
    expect((await put(mine, null, 5)).status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
    const unsigned = await (
      await import('../src/index.js')
    ).default.fetch(
      new Request('https://api.example/settings', { headers: { Origin: fixture.env.SITE_ORIGIN } }),
      fixture.env,
      { waitUntil: () => undefined },
    );
    expect(unsigned.status).toBe(401);
  });

  it('allows every role, including translators', async () => {
    for (const id of [1, 2, 3, 4]) {
      const response = await put(mine, null, id);
      expect(response.status).toBe(200);
    }
    expect(settingsFiles()).toHaveLength(4);
  });

  it('stores ciphertext only, under an opaque path, credited to the bot', async () => {
    const response = await put(mine, null);
    expect(response.status).toBe(200);
    const { revision } = (await response.json()) as { revision: string };
    const files = settingsFiles();
    expect(files).toHaveLength(1);
    const [path, stored] = files[0];
    expect(path).toMatch(/^user-settings\/[0-9a-f]{64}\.json$/);
    const bytes = `${path}\n${JSON.stringify(stored)}\n${JSON.stringify(fixture.commits[0])}`;
    for (const leak of ['alice', '"1"', 'Europe/Berlin', 'iso', 'markupToolbar', 'dateFormat']) {
      expect(bytes).not.toContain(leak);
    }
    expect(path).not.toMatch(/(^|\/)1\.json$/);
    expect(Object.keys(stored as object).sort()).toEqual(['ct', 'iv', 'v']);
    expect(fixture.commits[0]).toMatchObject({
      message: 'Update synced settings',
      author: { name: 'clarity-test[bot]', email: 'clarity-test[bot]@users.noreply.github.com' },
      committer: { name: 'clarity-test[bot]' },
    });
    const read = await fixture.request('/settings', 'GET');
    expect(await read.json()).toEqual({ settings: mine, revision, unreadable: false });
  });

  it('returns 409 with the stored copy when another device synced first', async () => {
    const first = (await (await put(mine, null)).json()) as { revision: string };
    const stale = await put({ ...mine, dateFormat: 'mdy' }, null);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ settings: mine, revision: first.revision });
    const next = await put({ ...mine, dateFormat: 'mdy' }, first.revision);
    expect(next.status).toBe(200);
    expect(fixture.commits).toHaveLength(2);
  });

  it('skips no-op writes and retries when the data branch moves', async () => {
    const first = (await (await put(mine, null)).json()) as { revision: string };
    const same = await put(mine, first.revision);
    expect(await same.json()).toEqual({ settings: mine, revision: first.revision });
    expect(fixture.commits).toHaveLength(1);
    fixture.patchRaces = 1;
    expect((await put({ ...mine, timeDisplay: 'relative' }, first.revision)).status).toBe(200);
  });

  it('reports tampered files as unreadable and lets the owner overwrite them', async () => {
    const first = (await (await put(mine, null)).json()) as { revision: string };
    const [path, stored] = settingsFiles()[0];
    const envelope = stored as { v: 1; iv: string; ct: string };
    fixture.moveData({ [path]: { ...envelope, iv: 'AAAAAAAAAAAAAAAA' } });
    const read = (await (await fixture.request('/settings', 'GET')).json()) as {
      settings: null;
      revision: string;
      unreadable: boolean;
    };
    expect(read.settings).toBeNull();
    expect(read.unreadable).toBe(true);
    expect(read.revision).not.toBe(first.revision);
    expect((await put(mine, read.revision)).status).toBe(200);
  });

  it('validates the schema and limits the size', async () => {
    expect((await put({ ...mine, extra: true }, null)).status).toBe(400);
    expect((await put({ ...mine, timeZone: 'Mars/Olympus' }, null)).status).toBe(400);
    expect((await put(mine, 'not-a-sha')).status).toBe(400);
    const huge = await fixture.request('/settings', 'PUT', {
      settings: mine,
      revision: null,
      filler: 'x'.repeat(5000),
    });
    expect(huge.status).toBe(413);
    expect(fixture.commits).toHaveLength(0);
  });
});
