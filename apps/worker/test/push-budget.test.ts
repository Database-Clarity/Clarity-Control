import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { GitHub, subrequestLimit } from '../src/github.js';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import { pushTime } from './push-fixture.js';

// Workers FREE plan: 50 external subrequests per request. Every fetch the Worker makes is
// counted by the fixture; these tests pin the total for pushes of any size.
let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: pushTime });
  fixture = new Fixture(key);
  // The real live file is over 1 MB, so reading it takes two requests (contents + blob).
  fixture.largeFile = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seed(count: number): number[] {
  const values: Tooltip[] = Array.from({ length: count }, (_, index) => ({
    ...tooltip(`Text ${index}`),
    hash: 10_000 + index,
  }));
  fixture.extraItems = Object.fromEntries(
    values.map(({ hash }) => [hash, { hash, name: `Perk ${hash}`, categoryId: 'perk' }]),
  );
  fixture.moveData(
    Object.fromEntries(values.map((value) => [`tooltips/${value.hash}.json`, value])),
  );
  return values.map(({ hash }) => hash);
}

describe('push-live subrequests', () => {
  it.each([1, 100, 500, 501, 1200])(
    'uses a flat number of upstream requests for %i tooltips',
    { timeout: 30_000 },
    async (count) => {
      const hashes = seed(count);
      fixture.subrequests = 0;
      const response = await fixture.request('/push-live', 'POST', { hashes });
      expect(response.status).toBe(200);
      const batches = Math.ceil(count / 500);
      expect(fixture.graphqlCalls).toBe(batches);
      // token 1 + catalog 3 + (head, permissions, batches, marker, live head, live file 2, PUT)
      // + (head, permissions, live head, marker, commit 4)
      expect(fixture.subrequests).toBe(19 + batches);
      expect(fixture.subrequests).toBeLessThanOrEqual(subrequestLimit);
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.commits).toHaveLength(1);
    },
  );

  // Thousands of tooltips are hashed and exported in-process; give them room on a loaded machine.
  const heavy = 30_000;

  it('accepts a selection of every tooltip there is', { timeout: heavy }, async () => {
    const hashes = seed(2600);
    fixture.subrequests = 0;
    const response = await fixture.request('/push-live', 'POST', { hashes });
    expect(response.status).toBe(200);
    expect(fixture.subrequests).toBe(19 + 6);
    expect(Object.keys(fixture.current()['live/pushed.json'] as object)).toHaveLength(2600);
  });

  it('does not re-read tooltips on a live-branch retry, and counts retries', async () => {
    const hashes = seed(600);
    fixture.liveRaces = 2;
    fixture.subrequests = 0;
    const response = await fixture.request('/push-live', 'POST', { hashes });
    expect(response.status).toBe(200);
    expect(fixture.graphqlCalls).toBe(2);
    // first attempt 7 + 2 batches; each retry: head, live head, live file 2, PUT = 5
    expect(fixture.subrequests).toBe(4 + (7 + 2) + 5 * 2 + 8);
    expect(fixture.subrequests).toBeLessThanOrEqual(subrequestLimit);
  });

  it('re-reads tooltips and permissions when the data branch moved between attempts', async () => {
    const hashes = seed(600);
    fixture.beforeLive = () => fixture.moveData();
    fixture.subrequests = 0;
    const response = await fixture.request('/push-live', 'POST', { hashes });
    expect(response.status).toBe(200);
    expect(fixture.graphqlCalls).toBe(4);
    expect(fixture.subrequests).toBeLessThanOrEqual(subrequestLimit);
  });

  it(
    'stops a retry that would not leave room to record the push, before writing anything',
    { timeout: heavy },
    async () => {
      const hashes = seed(6000);
      fixture.largeFile = false;
      fixture.liveRaces = 1;
      fixture.subrequests = 0;
      const response = await fixture.request('/push-live', 'POST', { hashes });
      expect(response.status).toBe(409);
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.commits).toHaveLength(0);
      expect(fixture.subrequests).toBeLessThanOrEqual(subrequestLimit);
    },
  );

  it('refuses a selection beyond the request bound', async () => {
    const response = await fixture.request('/push-live', 'POST', {
      hashes: Array.from({ length: 10_001 }, (_, index) => index + 1),
    });
    expect(response.status).toBe(400);
    expect(fixture.subrequests).toBe(0);
  });

  it('reads a blob GraphQL truncates through the contents API', async () => {
    const hashes = seed(3);
    fixture.truncateGraphql = true;
    fixture.subrequests = 0;
    const response = await fixture.request('/push-live', 'POST', { hashes });
    expect(response.status).toBe(200);
    expect(fixture.subrequests).toBe(19 + 1 + 3);
  });
});

describe('batched reads elsewhere', () => {
  it('saves 100 tooltips with one batched read', async () => {
    const changes = Array.from({ length: 100 }, (_, index) => {
      const next = { ...tooltip(`New ${index}`), hash: 20_000 + index };
      return { hash: next.hash, base: null, next };
    });
    fixture.subrequests = 0;
    const response = await fixture.request('/save', 'POST', { changes, message: 'Bulk' });
    expect(response.status).toBe(200);
    // token 1, head, permissions, aliases, one batch, commit 4
    expect(fixture.subrequests).toBe(9);
    expect(fixture.graphqlCalls).toBe(1);
  });

  it('rejects references that could name another ref or path', async () => {
    const github = new GitHub(fixture.env);
    const ref = fixture.dataHead;
    for (const bad of [
      { ref: 'editor-data', path: 'tooltips/1.json' },
      { ref: `${ref}:x`, path: 'tooltips/1.json' },
      { ref, path: '../config/permissions.json' },
      { ref, path: 'tooltips/1.json:other' },
      { ref, path: 'tooltips//1.json' },
      { ref, path: '/tooltips/1.json' },
      { ref, path: 'tooltips/1.json\n' },
      { ref, path: '' },
    ]) {
      await expect(github.blobs([bad])).rejects.toMatchObject({ status: 400 });
    }
    expect(fixture.subrequests).toBe(0);
  });

  it('decodes the line-wrapped base64 the contents API returns', async () => {
    fixture.wrapBase64 = true;
    const file = await new GitHub(fixture.env).file('tooltips/123.json', fixture.dataHead);
    expect(file?.value).toEqual(tooltip());
  });

  it('reports a missing path as null and keeps order', async () => {
    const github = new GitHub(fixture.env);
    const files = await github.files(
      ['tooltips/999999.json', 'tooltips/123.json', 'tooltips/5.json'],
      fixture.dataHead,
    );
    expect(files.map((file) => file?.value ?? null)).toEqual([null, tooltip(), null]);
  });
});
