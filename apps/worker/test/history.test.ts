import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyPublishableHash, publishableHash } from '@clarity/core';
import { subrequestLimit } from '../src/github.js';
import { Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

// The legacy /push-live exporter (switch OFF) under test; the checked-in switch is ON since
// PUB-ENABLE, and these paths stay for the publisher rollback.
vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));

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

describe('pushed history snapshots', () => {
  it('distinguishes never published from unavailable historical content', async () => {
    expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
      pushedHash: null,
      tooltip: null,
    });
    fixture.moveData({ 'live/pushed.json': { 123: 'f'.repeat(64) } });
    const response = await fixture.request('/history/123?live=1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('could not be recovered'),
    });
  });
  it('stores the exact exported version atomically with pushed markers despite later saves', async () => {
    fixture.beforePatch = () => fixture.moveData({ 'tooltips/123.json': tooltip('newer save') });
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(fixture.current()['live/tooltips/123.json']).toEqual(tooltip());
    const result = await fixture.request('/history/123?live=1');
    expect(await result.json()).toEqual({
      pushedHash: await publishableHash(tooltip(), fixture.aliases),
      tooltip: tooltip(),
    });
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip('newer save'));
  });
  it('recovers old markers by matching publishable content rather than current saved text', async () => {
    fixture.moveData({
      'tooltips/123.json': tooltip('newer'),
      'live/pushed.json': { 123: await publishableHash(tooltip(), fixture.aliases) },
    });
    expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
      pushedHash: await publishableHash(tooltip(), fixture.aliases),
      tooltip: tooltip(),
    });
  });
  it('searches a deep history with a batched read per page, within the subrequest limit', async () => {
    fixture.history = Array.from({ length: 30 }, (_, index) => ({
      sha: sha(500 + index),
      commit: {
        author: { name: 'alice', date: '2026-10-01T00:00:00Z' },
        message: `commit ${index}`,
      },
      author: { login: 'alice' },
    }));
    fixture.moveData({ 'live/pushed.json': { 123: 'f'.repeat(64) } });
    fixture.subrequests = 0;
    const response = await fixture.request('/history/123?live=1');
    expect(response.status).toBe(409);
    // token, head, permissions, marker, snapshot, catalog 3, then 10 pages x (list + batch)
    expect(fixture.subrequests).toBe(1 + 1 + 1 + 1 + 1 + 3 + 10 * 2);
    expect(fixture.graphqlCalls).toBe(10);
    expect(fixture.subrequests).toBeLessThanOrEqual(subrequestLimit);
  });
  it('recovers a marker recorded before the fallback digest existed', async () => {
    const stamp = '2026-10-01T00:00:00Z';
    const stale = {
      ...tooltip(),
      text: {
        en: { text: 'original', updatedAt: stamp, updatedBy: 'alice' },
        de: {
          text: 'Deutsch',
          updatedAt: '2026-01-01T00:00:00Z',
          updatedBy: 'dan',
          sourceUpdatedAt: '2026-01-01T00:00:00Z',
        },
      },
    };
    const legacy = await legacyPublishableHash(stale);
    expect(legacy).not.toBe(await publishableHash(stale, fixture.aliases));
    // The history scan reads the tooltip as committed at the listed commit (sha 1).
    Object.assign(fixture.snapshots.get(sha(1))!, { 'tooltips/123.json': stale });
    fixture.moveData({
      'tooltips/123.json': tooltip('newer'),
      'live/pushed.json': { 123: legacy },
    });
    expect(await (await fixture.request('/history/123?live=1')).json()).toEqual({
      pushedHash: legacy,
      tooltip: stale,
    });
  });
  it('does not present a snapshot stored for another tooltip as live text', async () => {
    fixture.moveData({
      'live/pushed.json': { 123: await publishableHash(tooltip(), fixture.aliases) },
      'live/tooltips/123.json': { ...tooltip(), hash: 124 },
    });
    expect((await fixture.request('/history/123?live=1')).status).toBe(502);
  });
  it('checks read permissions before exposing pushed history', async () => {
    expect((await fixture.request('/history/123?live=1', 'GET', undefined, 5)).status).toBe(403);
    expect((await fixture.request('/history/123?live=1', 'GET', undefined, 4)).status).toBe(200);
  });
  it('returns GitHub login/avatar independently from fallback commit author', async () => {
    const author = { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' };
    fixture.history[0].author = author;
    const result = await fixture.request('/history/123');
    expect(await result.json()).toMatchObject({
      commits: [
        { author: 'alice', login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/1' },
      ],
    });
  });
  it('refuses to publish a version that changed since it was reviewed', async () => {
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: await publishableHash(tooltip('reviewed older version'), fixture.aliases) },
    });
    expect(response.status).toBe(409);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });
  it('accepts a matching review digest while preserving the original hashes-only API', async () => {
    const response = await fixture.request('/push-live', 'POST', {
      hashes: [123],
      expected: { 123: await publishableHash(tooltip(), fixture.aliases) },
    });
    expect(response.status).toBe(200);
    expect(fixture.current()['live/tooltips/123.json']).toEqual(tooltip());
  });
});
