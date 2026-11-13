import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mergeSandboxPointers,
  publishableHash,
  sandboxPointersPath,
  type SandboxPointers,
  type Tooltip,
} from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { blobOid, Fixture, makePrivateKey, tooltip } from './fixture.js';

// The real Worker routes against the local GitHub adapter: the maintainer-only picks route with its
// revision check and validation, and the paths that apply picks (push-live stubs, save, publish).
let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-12T20:00:00Z') });
  fixture = new Fixture(key);
  fixture.aliases = {};
  // 700 is shared by 123 and 124 (different tooltips); 701 by 123 and 125; 702 by 124 and 125.
  fixture.sandboxConflicts = { 700: [124, 123], 701: [123, 125], 702: [124, 125] };
  fixture.extraItems = {
    124: { hash: 124, name: 'Other perk', categoryId: 'perk' },
    126: { hash: 126, name: 'Blank perk', categoryId: 'perk' },
  };
  fixture.moveData({
    'tooltips/124.json': { ...tooltip('other'), hash: 124 },
    'tooltips/126.json': { ...tooltip(''), hash: 126 },
  });
});
afterEach(() => {
  publisherConfig.enabled = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Picks = Record<string, { to: number } | { none: true }>;
const get = (user = 1) => fixture.request('/sandbox-pointers', 'GET', undefined, user);
const put = (picks: Picks, revision: string | null = null, user = 1) =>
  fixture.request('/sandbox-pointers', 'PUT', { revision, picks }, user);
const stored = () => fixture.current()[sandboxPointersPath] as SandboxPointers | undefined;

describe('sandbox picks route', () => {
  it('refuses every non-maintainer role, for reads and saves', async () => {
    for (const user of [2, 3, 4, 99]) {
      expect((await get(user)).status).toBe(403);
      expect((await put({ 700: { to: 123 } }, null, user)).status).toBe(403);
    }
    expect(fixture.commits).toHaveLength(0);
    expect(stored()).toBeUndefined();
  });

  it('answers a non-maintainer 403 even when the body is malformed', async () => {
    const malformed = await fixture.request('/sandbox-pointers', 'PUT', { picks: 'x' }, 2);
    expect(malformed.status).toBe(403);
    expect((await fixture.request('/sandbox-pointers', 'PUT', { picks: 'x' }, 1)).status).toBe(400);
  });

  it('reads an absent file as no picks with a null revision', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: null,
      pointers: { version: 1, pointers: {} },
      exporting: true,
    });
  });

  it('saves picks authored by the maintainer, recording who, when, and the candidate set', async () => {
    const response = await put({ 700: { to: 123 }, 702: { none: true } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const expected: SandboxPointers = {
      version: 1,
      pointers: {
        700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' },
        702: { none: true, candidates: [124, 125], by: 1, at: '2026-11-12T20:00:00Z' },
      },
    };
    expect(stored()).toEqual(expected);
    expect(body.pointers).toEqual(expected);
    expect(body.revision).toBe(blobOid(expected));
    expect(fixture.commits).toHaveLength(1);
    expect(fixture.commits[0]).toMatchObject({
      message: 'Update sandbox perk picks (2) by alice',
      author: { name: 'alice', email: '1+alice@users.noreply.github.com' },
    });
    // The returned revision is the one the next GET reports.
    expect((await (await get()).json()).revision).toBe(body.revision);
  });

  it('refuses a stale revision, including one that went stale during a ref race', async () => {
    const first = await (await put({ 700: { to: 123 } })).json();
    // Another maintainer saved first: the revision this client holds is stale.
    expect((await put({ 700: { to: 124 } }, null)).status).toBe(409);
    expect((await put({ 700: { to: 124 } }, '0'.repeat(40))).status).toBe(409);
    // The file changes while this save's commit is in flight: the retry re-checks and refuses.
    fixture.beforePatch = () =>
      fixture.moveData({
        [sandboxPointersPath]: { version: 1, pointers: {} },
      });
    const raced = await put({ 700: { none: true } }, first.revision);
    expect(raced.status).toBe(409);
    expect(stored()).toEqual({ version: 1, pointers: {} });
  });

  it('keeps an unchanged pick as stored and turns an omitted pick into an undone tombstone', async () => {
    const first = await (await put({ 700: { to: 123 }, 701: { to: 123 } })).json();
    vi.setSystemTime(Date.parse('2026-11-13T08:00:00Z'));
    const second = await (await put({ 700: { to: 123 } }, first.revision, 1)).json();
    expect(second.pointers.pointers).toEqual({
      700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' },
      701: { state: 'undone', by: 1, at: '2026-11-13T08:00:00Z' },
    });
    // The tombstone stays as stored; picking 701 again is a new decision.
    const third = await (await put({ 700: { to: 123 } }, second.revision)).json();
    expect(third.pointers.pointers['701']).toEqual({
      state: 'undone',
      by: 1,
      at: '2026-11-13T08:00:00Z',
    });
    const fourth = await (
      await put({ 700: { to: 123 }, 701: { none: true } }, third.revision)
    ).json();
    expect(fourth.pointers.pointers['701']).toMatchObject({ none: true, by: 1 });
  });

  it('validates picks: shared perk, canonical non-empty target, no own tooltip', async () => {
    fixture.aliases = { 900: { to: 123, kind: 'frame' } };
    fixture.sandboxConflicts = { ...fixture.sandboxConflicts, 703: [123, 900], 704: [123, 2] };
    const cases: [Picks, string][] = [
      [{ 999: { to: 123 } }, '999 is not a shared sandbox perk'],
      [{ 703: { to: 900 } }, 'which is an alias'],
      [{ 700: { to: 700 } }, 'cannot point at itself'],
      [{ 700: { to: 701 }, 701: { to: 123 } }, 'another shared sandbox perk'],
      // Canonical and with text, but not one of the tooltips sharing 700 (123 and 124).
      [{ 700: { to: 126 } }, 'which is not one of the tooltips sharing it'],
    ];
    for (const [picks, message] of cases) {
      const response = await put(picks);
      expect(response.status, message).toBe(422);
      expect(JSON.stringify((await response.json()).details)).toContain(message);
    }
    // Candidates resolve through generator aliases; a candidate without text is refused.
    fixture.sandboxConflicts = { ...fixture.sandboxConflicts, 705: [555, 126], 706: [901] };
    fixture.aliases = { ...fixture.aliases, 901: { to: 124, kind: 'frame' } };
    for (const [picks, message] of [
      [{ 705: { to: 555 } }, 'Tooltip 555 does not exist or has no text'],
      [{ 705: { to: 126 } }, 'Tooltip 126 does not exist or has no text'],
    ] as [Picks, string][]) {
      const response = await put(picks);
      expect(response.status, message).toBe(422);
      expect(JSON.stringify((await response.json()).details)).toContain(message);
    }
    fixture.moveData({ 'tooltips/704.json': { ...tooltip('own'), hash: 704 } });
    const own = await put({ 704: { to: 123 } });
    expect(own.status).toBe(422);
    expect(JSON.stringify((await own.json()).details)).toContain('704 has its own tooltip');
    // Exactly one of to/none; nothing else is accepted from the client.
    for (const pick of [{ to: 123, none: true }, {}, { to: 123, by: 7 }])
      expect((await put({ 700: pick } as unknown as Picks)).status).toBe(400);
    expect(fixture.commits).toHaveLength(0);
    // A candidate behind a generator alias (901 -> 124) is a valid target.
    expect((await put({ 706: { to: 124 } })).status).toBe(200);
  });

  it('publisher on: refuses saves until the installed build declares the capability', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({ '.publisher/PIN': { sourceSha: 'a'.repeat(40), capabilities: [] } });
    expect((await (await get()).json()).exporting).toBe(false);
    const refused = await put({ 700: { to: 123 } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain('"sandboxPointers" capability');
    fixture.moveData({
      '.publisher/PIN': { sourceSha: 'a'.repeat(40), capabilities: ['sandboxPointers'] },
    });
    expect((await (await get()).json()).exporting).toBe(true);
    expect((await put({ 700: { to: 123 } })).status).toBe(200);
  });

  it('re-checks a target at each head: one emptied during a ref race is refused', async () => {
    fixture.beforePatch = () => fixture.moveData({ 'tooltips/123.json': tooltip('') });
    const response = await put({ 700: { to: 123 } });
    expect(response.status).toBe(422);
    expect(JSON.stringify((await response.json()).details)).toContain('Tooltip 123');
    expect(stored()).toBeUndefined();
  });

  it('fails closed on a malformed stored file', async () => {
    fixture.moveData({ [sandboxPointersPath]: { version: 1, pointers: { 700: { to: 123 } } } });
    expect((await get()).status).toBe(502);
  });
});

describe('picks in the live export', () => {
  const pushTooltip = async (hashes: number[]) => fixture.request('/push-live', 'POST', { hashes });

  it('writes a sandbox stub for a pick, none for "no tooltip", and digests with the merge', async () => {
    await put({ 700: { to: 123 }, 701: { none: true } });
    fixture.subrequests = 0;
    fixture.sandboxConflictReads = 0;
    const response = await pushTooltip([123]);
    expect(response.status).toBe(200);
    const perks = (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
    expect(perks).not.toHaveProperty('701');
    expect(perks).not.toHaveProperty('702');
    const merged = mergeSandboxPointers({}, fixture.sandboxConflicts, stored());
    expect(fixture.current()['live/pushed.json']).toEqual({
      123: await publishableHash(fixture.current()['tooltips/123.json'] as Tooltip, merged),
    });
    // One extra request: the generator conflicts (the picks file rides in the tooltip batch).
    expect(fixture.sandboxConflictReads).toBe(1);
    // token 1 + catalog 3 + 7 + one tooltip batch + record 8 (small live file) = 20, + conflicts.
    expect(fixture.subrequests).toBe(20 + 1);
  });

  it('keeps a pick working after its candidate set changed (the row is only flagged)', async () => {
    await put({ 700: { to: 123 } });
    fixture.sandboxConflicts = { ...fixture.sandboxConflicts, 700: [123, 124, 125] };
    expect((await pushTooltip([123])).status).toBe(200);
    const perks = (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
  });

  it('withdraws a published stub when its pick becomes "no tooltip" or is undone', async () => {
    const first = await (await put({ 700: { to: 123 }, 701: { to: 123 } })).json();
    expect((await pushTooltip([123])).status).toBe(200);
    const perks = () => (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks()['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
    // 700 -> no tooltip, 701 undone: the next push of 123 removes both stubs, keeps 123.
    expect((await put({ 700: { none: true } }, first.revision)).status).toBe(200);
    expect((await pushTooltip([123])).status).toBe(200);
    expect(perks()).not.toHaveProperty('700');
    expect(perks()).not.toHaveProperty('701');
    expect(perks()).toHaveProperty('123');
  });

  it('moves a published stub when its pick is retargeted', async () => {
    const first = await (await put({ 700: { to: 123 } })).json();
    expect((await pushTooltip([123])).status).toBe(200);
    expect((await put({ 700: { to: 124 } }, first.revision)).status).toBe(200);
    const perks = () => (fixture.live as { perks: Record<string, unknown> }).perks;
    // Any push recomputes 700: absent while 124 is not live yet, then the stub to 124.
    expect((await pushTooltip([123])).status).toBe(200);
    expect(perks()).not.toHaveProperty('700');
    expect((await pushTooltip([124])).status).toBe(200);
    expect(perks()['700']).toEqual({ hash: 700, aliasOf: 124, aliasKind: 'sandbox' });
    // And back to 123: a push of either tooltip moves it.
    const moved = await (await get()).json();
    expect((await put({ 700: { to: 123 } }, moved.revision)).status).toBe(200);
    expect((await pushTooltip([124])).status).toBe(200);
    expect(perks()['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
  });

  it('undo on a perk no longer shared clears its stub (round-3 counterexample)', async () => {
    const first = await (await put({ 700: { to: 123 } })).json();
    expect((await pushTooltip([123])).status).toBe(200);
    const perks = () => (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks()['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
    // The generator retires 700; the maintainer undoes the retired row and saves.
    fixture.sandboxConflicts = { 701: [123, 125], 702: [124, 125] };
    const undone = await put({}, first.revision);
    expect(undone.status).toBe(200);
    expect(stored()!.pointers['700']).toMatchObject({ state: 'undone' });
    expect((await pushTooltip([123])).status).toBe(200);
    expect(perks()).not.toHaveProperty('700');
  });

  it('undo on a perk the generator now owns gives the generator its entry back', async () => {
    const first = await (await put({ 700: { to: 123 } })).json();
    expect((await pushTooltip([123, 124])).status).toBe(200);
    // The generator stops sharing 700 and aliases it itself (to 124).
    fixture.sandboxConflicts = { 701: [123, 125], 702: [124, 125] };
    fixture.aliases = { 700: { to: 124, kind: 'sandbox' } };
    expect((await put({}, first.revision)).status).toBe(200);
    expect((await pushTooltip([123])).status).toBe(200);
    expect((fixture.live as { perks: Record<string, unknown> }).perks['700']).toEqual({
      hash: 700,
      aliasOf: 124,
      aliasKind: 'sandbox',
    });
  });

  it('undo then re-pick writes the stub again', async () => {
    const first = await (await put({ 700: { to: 123 } })).json();
    expect((await pushTooltip([123])).status).toBe(200);
    const undone = await (await put({}, first.revision)).json();
    expect((await pushTooltip([123])).status).toBe(200);
    const perks = () => (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks()).not.toHaveProperty('700');
    expect((await put({ 700: { to: 123 } }, undone.revision)).status).toBe(200);
    expect((await pushTooltip([123])).status).toBe(200);
    expect(perks()['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
  });

  it('ignores a pick once the generator no longer lists the perk as shared', async () => {
    await put({ 700: { to: 123 } });
    fixture.sandboxConflicts = { 701: [123, 125] };
    expect((await pushTooltip([123])).status).toBe(200);
    expect((fixture.live as { perks: Record<string, unknown> }).perks).not.toHaveProperty('700');
  });

  it('keeps a stale generator sandbox stub: only keys the picks file names are recomputed', async () => {
    const live = fixture.live as { perks: Record<string, unknown> };
    live.perks = { ...live.perks, 800: { hash: 800, aliasOf: 123, aliasKind: 'sandbox' } };
    expect((await pushTooltip([123])).status).toBe(200);
    expect((fixture.live as typeof live).perks['800']).toEqual({
      hash: 800,
      aliasOf: 123,
      aliasKind: 'sandbox',
    });
    // With a picks file, a stub the file does not name still stays.
    await put({ 701: { none: true } });
    expect((await pushTooltip([123])).status).toBe(200);
    expect((fixture.live as typeof live).perks['800']).toEqual({
      hash: 800,
      aliasOf: 123,
      aliasKind: 'sandbox',
    });
  });

  it('with no picks file the export and its cost are unchanged', async () => {
    fixture.subrequests = 0;
    expect((await pushTooltip([123])).status).toBe(200);
    expect(fixture.sandboxConflictReads).toBe(0);
    expect(fixture.subrequests).toBe(20);
    expect(fixture.current()['live/pushed.json']).toEqual({
      123: await publishableHash(fixture.current()['tooltips/123.json'] as Tooltip, {}),
    });
  });

  it('refuses a save that would give a picked sandbox perk its own tooltip', async () => {
    await put({ 700: { to: 123 } });
    const response = await fixture.request('/save', 'POST', {
      changes: [{ hash: 700, base: null, next: { ...tooltip('own'), hash: 700 } }],
      message: 'Add',
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 700 is an alias');
  });
});
