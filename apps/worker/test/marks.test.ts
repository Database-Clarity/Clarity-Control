import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { marksPath, maxMarksBytes, type MarkAction, type Marks } from '@clarity/core/marks';
import { blobContent } from '../src/github.js';
import { blobOid, Fixture, makePrivateKey } from './fixture.js';

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
      Array.from({ length: 402 }, (_, hash) => [
        hash,
        [{ type: 'retest', note: 'x'.repeat(500), by: 1, at }],
      ]),
    ),
  };
  expect(Buffer.byteLength(blobContent(full))).toBeLessThanOrEqual(maxMarksBytes);
  revision = seed(full);
  expect((await put({ ...mark, hash: 999999, note: 'x'.repeat(500) }, revision)).status).toBe(400);
  expect(fixture.commits).toHaveLength(0);
});
it('fails closed on malformed storage and unknown or duplicate mark types', async () => {
  for (const value of [
    [],
    {},
    { ...base, entries: { 123: [{ type: 'missing', by: 1, at }] } },
    { ...base, types: [base.types[0], base.types[0]] },
  ]) {
    fixture.moveData({ [marksPath]: value });
    expect((await get()).status).toBe(502);
    expect((await put(mark, blobOid(value))).status).toBe(502);
  }
  expect(fixture.commits).toHaveLength(0);
});
it('bounds the total number of marks even when entries carry several types', async () => {
  const types = Array.from({ length: 31 }, (_, index) => ({
    ...base.types[0],
    id: `type-${index}`,
    label: `Type ${index}`,
  }));
  const entries = Object.fromEntries(
    Array.from({ length: 32 }, (_, hash) => [
      hash,
      types.map((type) => ({ type: type.id, by: 1, at })),
    ]),
  );
  entries[32] = types.slice(0, 8).map((type) => ({ type: type.id, by: 1, at }));
  const revision = seed({ types, entries });
  expect((await put({ ...mark, hash: 99999, type: 'type-0' }, revision)).status).toBe(400);
  expect(fixture.commits).toHaveLength(0);
});
it('bounds input, rejects forged attribution, and prevents stale type writes', async () => {
  const revision = seed();
  for (const change of [
    { ...mark, note: 'x'.repeat(501) },
    { ...mark, by: 99 },
    { ...mark, hash: -1 },
    { ...mark, hash: 0x100000000 },
    { action: 'create-type', id: '../bad', label: 'Test', colour: 'red' },
    { action: 'create-type', id: 'new', label: 'x'.repeat(65), colour: 'red' },
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
