import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  entryMarkSchema,
  marksFileSchema,
  marksPath,
  markTypeSchema,
  maxMarkNoteChars,
  maxMarksBytes,
  type MarkAction,
  type Marks,
} from '@clarity/core/marks';
import { inactiveHashKey } from '@clarity/core';
import { z } from 'zod';
import { blobContent } from '../src/github.js';
import { blobOid, config, Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
const at = '2026-11-15T00:00:00Z';
const base: Marks = {
  types: [{ id: 'retest', label: 'Needs retesting', colour: 'amber', by: 1, at }],
  entries: {},
};
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const get = (user = 1) => fixture.request('/marks', 'GET', undefined, user);
const put = (change: MarkAction, revision: string | null = null, user = 1) =>
  fixture.request('/marks', 'PUT', { change, revision }, user);
const mark = { action: 'mark', hash: 123, type: 'retest', note: 'Check on Arc' } as const;
function seed(marks: Marks = base) {
  fixture.moveData({ [marksPath]: marks });
  return blobOid(marks);
}

const setDecision = {
  action: 'compendium-set',
  kind: 'no-match',
  hashes: [123, 123, 4294967295],
} satisfies MarkAction;
const clearDecision = {
  action: 'compendium-clear',
  hashes: [123, 4294967295],
} satisfies MarkAction;

it('gates both decision actions to maintainers and defaults writes off', async () => {
  const revision = seed();
  fixture.moveData({
    'config/permissions.json': {
      ...config,
      partners: { 5: { login: 'partner', projects: ['dim'] } },
    },
  });
  for (const action of [setDecision, clearDecision]) {
    expect((await put(action, revision)).status).toBe(503);
    for (const user of [2, 3, 4, 5, 99])
      expect((await put(action, revision, user)).status).toBe(403);
  }
  expect((await put(mark, revision, 2)).status).toBe(200);
  expect(fixture.commits).toHaveLength(1);
});

it('sets and clears supplied hashes idempotently while preserving all ordinary marks', async () => {
  fixture.env.COMPENDIUM_DECISION_WRITES = '1';
  const initial = { ...base, entries: { 123: [{ type: 'retest', note: 'Retest', by: 2, at }] } };
  const revision = seed(initial);
  const originalTooltip = fixture.current()['tooltips/123.json'];
  const originalLive = fixture.liveHead;
  const response = await put(setDecision, revision);
  expect(response.status).toBe(200);
  const saved = await response.json();
  const decision = { kind: 'no-match', by: 1, at: expect.any(String) };
  expect(saved.marks).toEqual({
    ...initial,
    compendium: { 123: decision, 4294967295: decision },
  });
  expect(saved.revision).toBe(blobOid(saved.marks));
  expect(fixture.current()[marksPath]).toEqual(saved.marks);
  expect(fixture.current()['tooltips/123.json']).toEqual(originalTooltip);
  expect(fixture.liveHead).toBe(originalLive);
  expect(fixture.commits[0]).toMatchObject({
    author: { name: 'alice', email: '1+alice@users.noreply.github.com' },
  });
  for (const user of [1, 2, 3, 4])
    expect(await (await get(user)).json()).toEqual({
      revision: saved.revision,
      marks: saved.marks,
    });
  expect(await (await put(setDecision, saved.revision)).json()).toEqual({ ...saved, commit: null });
  expect(fixture.commits).toHaveLength(1);
  const ordinary = await (await put(mark, saved.revision, 2)).json();
  expect(ordinary.marks.compendium).toEqual(saved.marks.compendium);
  const updated = await (
    await put({ ...setDecision, kind: 'not-needed', hashes: [123] }, ordinary.revision)
  ).json();
  expect(updated.marks.compendium[123]).toMatchObject({ kind: 'not-needed', by: 1 });
  const cleared = await (await put(clearDecision, updated.revision)).json();
  expect(cleared.marks).toEqual({ ...initial, entries: ordinary.marks.entries });
  expect(await (await put(clearDecision, cleared.revision)).json()).toEqual({
    ...cleared,
    commit: null,
  });
  expect(fixture.commits).toHaveLength(4);
});

it('uses the whole-file revision on decision retries and rechecks the maintainer role', async () => {
  fixture.env.COMPENDIUM_DECISION_WRITES = '1';
  const revision = seed();
  fixture.beforePatch = () =>
    fixture.moveData({
      [marksPath]: {
        ...base,
        entries: { 123: [{ type: 'retest', note: 'Concurrent', by: 2, at }] },
      },
    });
  expect((await put(setDecision, revision)).status).toBe(409);
  const fresh = await (await get()).json();
  expect(fresh.marks.entries[123][0].note).toBe('Concurrent');
  expect(fresh.marks).not.toHaveProperty('compendium');
  fixture.beforePatch = () => fixture.moveData({ 'unrelated.json': { keep: true } });
  expect((await put(setDecision, fresh.revision)).status).toBe(200);
  expect(fixture.current()['unrelated.json']).toEqual({ keep: true });
  const saved = await (await get()).json();
  fixture.beforePatch = () =>
    fixture.moveData({
      'config/permissions.json': { users: { 1: { login: 'alice', role: 'editor' } } },
    });
  expect((await put(clearDecision, saved.revision)).status).toBe(403);
  expect(fixture.current()[marksPath]).toEqual(saved.marks);
});

it('reads old marks and stores thousands of decisions outside the entry-mark count', async () => {
  const legacy = z
    .object({
      types: z.array(markTypeSchema),
      entries: z.record(inactiveHashKey, z.array(entryMarkSchema)),
    })
    .strict();
  expect(marksFileSchema.parse(base)).toEqual(base);
  const marks: Marks = {
    ...base,
    entries: Object.fromEntries(
      Array.from({ length: 1500 }, (_, hash) => [hash, [{ type: 'retest', by: 1, at }]]),
    ),
    compendium: Object.fromEntries(
      Array.from({ length: 4000 }, (_, i) => [4294960000 + i, { kind: 'not-needed', by: 1, at }]),
    ),
  };
  expect(marksFileSchema.parse(marks)).toEqual(marks);
  expect(legacy.safeParse(marks).success).toBe(false);
  fixture.env.COMPENDIUM_DECISION_WRITES = '1';
  const response = await put(
    { ...setDecision, hashes: Array.from({ length: 350 }, (_, i) => 4294967295 - i) },
    seed(marks),
  );
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(Object.keys(saved.marks.compendium)).toHaveLength(4350);
  expect(saved.marks.entries).toEqual(marks.entries);
});

it('allows all editor roles to read, and denies unknown accounts', async () => {
  for (const user of [1, 2, 3, 4])
    expect(await (await get(user)).json()).toEqual({
      revision: null,
      marks: { types: [], entries: {} },
    });
  expect((await get(99)).status).toBe(403);
});
it('only editors and maintainers can mark; only maintainers can manage types', async () => {
  const revision = seed();
  for (const user of [3, 4, 99]) {
    expect((await put(mark, revision, user)).status).toBe(403);
    expect((await fixture.request('/marks', 'PUT', {}, user)).status).toBe(403);
  }
  for (const action of [
    { action: 'create-type', id: 'new', label: 'New', colour: 'neutral' },
    { action: 'edit-type', id: 'retest', label: 'Retest', colour: 'red' },
    { action: 'remove-type', id: 'retest', force: true },
  ])
    expect((await fixture.request('/marks', 'PUT', { change: action, revision }, 2)).status).toBe(
      403,
    );
  expect(fixture.commits).toHaveLength(0);
  expect((await put(mark, revision, 2)).status).toBe(200);
});
it('creates types, edits notes, and removes marks with real attribution and one commit each', async () => {
  const created = await put({
    action: 'create-type',
    id: 'retest',
    label: 'Needs retesting',
    colour: 'amber',
  });
  expect(created.status).toBe(200);
  let saved = await created.json();
  expect(saved.marks.types[0]).toMatchObject({ by: 1, at: expect.any(String) });
  const marked = await put(mark, saved.revision, 2);
  expect(marked.status).toBe(200);
  saved = await marked.json();
  expect(saved.revision).toBe(blobOid(saved.marks));
  expect(saved.marks.entries[123]).toEqual([
    { type: 'retest', note: mark.note, by: 2, at: expect.any(String) },
  ]);
  expect(fixture.commits[1]).toMatchObject({
    author: { name: 'bob', email: '2+bob@users.noreply.github.com' },
    committer: { name: 'clarity-test[bot]', email: 'clarity-test[bot]@users.noreply.github.com' },
  });
  saved = await (await put({ ...mark, note: 'New note' }, saved.revision)).json();
  expect(saved.marks.entries[123]).toHaveLength(1);
  expect(saved.marks.entries[123][0]).toMatchObject({ note: 'New note', by: 1 });
  saved = await (await put({ action: 'unmark', hash: 123, type: 'retest' }, saved.revision)).json();
  expect(saved.marks.entries).toEqual({});
  expect(fixture.commits).toHaveLength(4);
});
it('renames and recolours types without changing creator metadata', async () => {
  const response = await put(
    { action: 'edit-type', id: 'retest', label: 'Retest', colour: 'red' },
    seed(),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).marks.types).toEqual([
    { ...base.types[0], label: 'Retest', colour: 'red' },
  ]);
});
it('refuses an in-use type removal unless forced, then removes marks atomically', async () => {
  const marks = { ...base, entries: { 123: [{ type: 'retest', by: 2, at }] } };
  const revision = seed(marks);
  expect((await put({ action: 'remove-type', id: 'retest' }, revision)).status).toBe(409);
  expect(fixture.commits).toHaveLength(0);
  const response = await put({ action: 'remove-type', id: 'retest', force: true }, revision);
  expect(response.status).toBe(200);
  expect((await response.json()).marks).toEqual({ types: [], entries: {} });
  expect(fixture.commits).toHaveLength(1);
});
it('rejects stale revisions and ref-race edits to marks, preserving unrelated concurrent edits', async () => {
  const revision = seed();
  expect((await put(mark)).status).toBe(409);
  fixture.beforePatch = () => fixture.moveData({ 'unrelated.json': { keep: true } });
  expect((await put(mark, revision)).status).toBe(200);
  expect(fixture.current()['unrelated.json']).toEqual({ keep: true });
  const current = await (await get()).json();
  fixture.beforePatch = () => fixture.moveData({ [marksPath]: base });
  expect((await put({ ...mark, note: 'Other tab' }, current.revision)).status).toBe(409);
});
it('rechecks editor and maintainer roles after a ref race', async () => {
  const revision = seed();
  fixture.beforePatch = () =>
    fixture.moveData({
      'config/permissions.json': { users: { 2: { login: 'bob', role: 'trial' } } },
    });
  expect((await put(mark, revision, 2)).status).toBe(403);
  expect(fixture.current()[marksPath]).toEqual(base);
});
it('rechecks type-management privileges after a maintainer becomes an editor', async () => {
  const revision = seed();
  fixture.beforePatch = () =>
    fixture.moveData({
      'config/permissions.json': { users: { 1: { login: 'alice', role: 'editor' } } },
    });
  expect((await put({ action: 'remove-type', id: 'retest', force: true }, revision)).status).toBe(
    403,
  );
  expect(fixture.current()[marksPath]).toEqual(base);
});
it('enforces the type count and total file byte limits before committing', async () => {
  let revision = seed({
    ...base,
    types: Array.from({ length: 32 }, (_, index) => ({
      ...base.types[0],
      id: `type-${index}`,
      label: `Type ${index}`,
    })),
  });
  expect(
    (await put({ action: 'create-type', id: 'more', label: 'More', colour: 'blue' }, revision))
      .status,
  ).toBe(400);
  const full = {
    ...base,
    entries: Object.fromEntries(
      Array.from({ length: 1100 }, (_, hash) => [
        hash,
        [{ type: 'retest', note: 'x'.repeat(500), by: 1, at }],
      ]),
    ),
  };
  expect(Buffer.byteLength(blobContent(full))).toBeLessThanOrEqual(maxMarksBytes);
  const overflow = {
    ...full,
    entries: { ...full.entries, 999999: [{ type: 'retest', note: 'x'.repeat(500), by: 1, at }] },
  };
  expect(Buffer.byteLength(blobContent(overflow))).toBeGreaterThan(maxMarksBytes);
  revision = seed(full);
  expect((await put({ ...mark, hash: 999999, note: 'x'.repeat(500) }, revision)).status).toBe(400);
  fixture.env.COMPENDIUM_DECISION_WRITES = '1';
  const result = await put(
    { ...setDecision, hashes: [600000, 600001, 600002, 600003, 600004, 600005] },
    revision,
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({
    error: expect.stringContaining(
      'Entry marks and Compendium decisions share a 700,000-byte file limit',
    ),
  });
  expect(fixture.current()[marksPath]).toEqual(full);
  expect(fixture.commits).toHaveLength(0);
});
it('accepts a note at the character limit and still refuses the file byte cap at full-length notes', async () => {
  const revision = seed();
  const long = await put({ ...mark, note: 'x'.repeat(maxMarkNoteChars) }, revision);
  expect(long.status).toBe(200);
  const saved = await long.json();
  expect(saved.marks.entries[123][0].note).toHaveLength(maxMarkNoteChars);
  expect(
    (await put({ ...mark, note: 'x'.repeat(maxMarkNoteChars + 1) }, saved.revision)).status,
  ).toBe(400);
  const full = {
    ...base,
    entries: Object.fromEntries(
      Array.from({ length: 327 }, (_, hash) => [
        hash,
        [{ type: 'retest', note: 'x'.repeat(maxMarkNoteChars), by: 1, at }],
      ]),
    ),
  };
  expect(Buffer.byteLength(blobContent(full))).toBeLessThanOrEqual(maxMarksBytes);
  expect(
    (await put({ ...mark, hash: 999999, note: 'x'.repeat(maxMarkNoteChars) }, seed(full))).status,
  ).toBe(400);
  expect(fixture.commits).toHaveLength(1);
});
it('fails closed on malformed storage for writes, and on non-marks shapes for reads', async () => {
  const malformed: unknown[] = [
    [],
    {},
    { ...base, entries: { 123: [{ type: 'missing', by: 1, at }] } },
    { ...base, types: [base.types[0], base.types[0]] },
  ];
  // Every write still validates the whole stored document before touching it.
  for (const value of malformed) {
    fixture.moveData({ [marksPath]: value });
    expect((await put(mark, blobOid(value))).status).toBe(502);
  }
  // A read hands the stored file to the store, which validates it (marksFileSchema): only a
  // value that is not marks-shaped at all fails closed here.
  for (const value of [[], {}, { ...base, types: 'x' }]) {
    fixture.moveData({ [marksPath]: value });
    expect((await get()).status).toBe(502);
  }
  for (const value of malformed.slice(2)) {
    fixture.moveData({ [marksPath]: value });
    expect((await get()).status).toBe(200);
  }
  expect(fixture.commits).toHaveLength(0);
});
it('still refuses duplicate types, the marked-entry cap, and an unknown stored type', async () => {
  expect(
    (await put({ action: 'create-type', id: 'retest', label: 'Again', colour: 'red' }, seed()))
      .status,
  ).toBe(409);
  expect(
    (
      await put(
        { action: 'create-type', id: 'again', label: 'needs RETESTING', colour: 'red' },
        seed(),
      )
    ).status,
  ).toBe(400);
  const full = {
    ...base,
    entries: Object.fromEntries(
      Array.from({ length: 1500 }, (_, hash) => [hash, [{ type: 'retest', by: 1, at }]]),
    ),
  };
  expect((await put({ ...mark, hash: 999999 }, seed(full))).status).toBe(400);
  expect(
    (await put(mark, seed({ ...base, entries: { 123: [{ type: 'missing', by: 1, at }] } }))).status,
  ).toBe(502);
  expect(fixture.commits).toHaveLength(0);
});
it('bounds the total number of marks even when entries carry several types', async () => {
  const types = Array.from({ length: 32 }, (_, index) => ({
    ...base.types[0],
    id: `type-${index}`,
    label: `Type ${index}`,
  }));
  const entries = Object.fromEntries(
    Array.from({ length: 46 }, (_, hash) => [
      hash,
      types.map((type) => ({ type: type.id, by: 1, at })),
    ]),
  );
  entries[46] = types.slice(0, 28).map((type) => ({ type: type.id, by: 1, at }));
  const revision = seed({ types, entries });
  expect((await put({ ...mark, hash: 99999, type: 'type-0' }, revision)).status).toBe(400);
  expect(fixture.commits).toHaveLength(0);
});
it('bounds input, rejects forged attribution, and prevents stale type writes', async () => {
  const revision = seed();
  for (const change of [
    { ...mark, note: 'x'.repeat(maxMarkNoteChars + 1) },
    { ...mark, by: 99 },
    { ...mark, hash: -1 },
    { ...mark, hash: 0x100000000 },
    { action: 'create-type', id: '../bad', label: 'Test', colour: 'red' },
    { action: 'create-type', id: 'new', label: 'x'.repeat(65), colour: 'red' },
    { ...setDecision, kind: 'skip' },
    { ...setDecision, hashes: [] },
    { ...setDecision, hashes: [0x100000000] },
    { ...clearDecision, by: 99 },
  ])
    expect((await fixture.request('/marks', 'PUT', { change, revision })).status).toBe(400);
  expect(
    (
      await put(
        { action: 'create-type', id: 'other', label: 'NEEDS RETESTING', colour: 'red' },
        revision,
      )
    ).status,
  ).toBe(400);
  expect((await put({ ...mark, type: 'missing' }, revision)).status).toBe(409);
  expect(
    (
      await fixture.request('/marks', 'PUT', {
        change: { ...mark, note: 'x'.repeat(5000) },
        revision,
      })
    ).status,
  ).toBe(413);
  expect(fixture.commits).toHaveLength(0);
});
