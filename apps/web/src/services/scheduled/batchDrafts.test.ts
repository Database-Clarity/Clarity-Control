// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createDraftStore, useDraftStore } from '../../stores/drafts';
import { useDataStore } from '../../stores/data';
import { reconcileDrafts } from '../../features/conflicts/rebase';
import { createIndexedDbStorage, userDraftKey, type Drafts } from '../draftStorage';
import { acceptSaved, replaceDraft } from '../save/drafts';
import { editorData, english, tooltip } from '../save/fixtures.testSupport';
import {
  acceptBatchSaved,
  batchBucketKey,
  batchDraftKey,
  batchDraftsSchema,
  createBatchDraftStorage,
  createBatchDraftStore,
  discardBatchDraft,
  draftsOfBatch,
  editBatchDraft,
  linkBatchDrafts,
  parseBatchDraftKey,
  replaceBatchDraft,
  updateBatchDrafts,
  type BatchDraftStore,
} from './batchDrafts';
import { createBatchFixture, type BatchFixture } from './fixtureWorker.testSupport';

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const A = '01JF00000000000000000000AA';
const B = '01JF00000000000000000000BB';
let account = 0;
const nextAccount = () => `sweep-${++account}-${Date.now().toString(36)}`;

/** Raw IndexedDB contents of one key (what a reload would read). */
function rawRead(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('clarity-editor-v2', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    };
  });
}

/** One tab: a Current store and a batch store following its account. */
async function tab(user: string | null, origin: string) {
  const current = createDraftStore(createIndexedDbStorage('tooltips', origin));
  const batch = createBatchDraftStore(createBatchDraftStorage(origin));
  const stop = linkBatchDrafts(current, batch);
  await current.getState().activate(user);
  await batch.getState().hydrate();
  return { current, batch, stop };
}

const saveBody = (submitted: Drafts) => ({
  changes: Object.values(submitted).map(({ base, next }) => ({ hash: next.hash, base, next })),
});
async function post(fixture: BatchFixture, path: string, body: unknown) {
  const response = await fixture.fetch(`https://worker.test${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, never> };
}

describe('batch draft keys and schema', () => {
  it('round-trips batch:<batchId>:<hash> and rejects Current and malformed keys', () => {
    expect(batchDraftKey(A, 123)).toBe(`batch:${A}:123`);
    expect(parseBatchDraftKey(`batch:${A}:123`)).toEqual({ batchId: A, hash: 123 });
    for (const key of ['123', `batch:${A}:0123`, `batch:not-a-ulid:1`, `batch:${A}:`, `x:${A}:1`])
      expect(parseBatchDraftKey(key)).toBeNull();
    const draft = { base: tooltip, next: tooltip };
    expect(batchDraftsSchema.safeParse({ [batchDraftKey(A, 123)]: draft }).success).toBe(true);
    // A Current-shaped record and a key naming another hash are both invalid batch drafts.
    expect(batchDraftsSchema.safeParse({ 123: draft }).success).toBe(false);
    expect(batchDraftsSchema.safeParse({ [batchDraftKey(A, 124)]: draft }).success).toBe(false);
  });
});

describe('STATE SWEEP: batch drafts (flag ON, real IndexedDB and BroadcastChannel)', () => {
  it('two destinations for one hash stay independent, in memory and on disk', async () => {
    const user = nextAccount();
    const { current, batch, stop } = await tab(user, `two-${user}`);
    current.getState().edit(tooltip, 'en', 'Current wording', 'alice');
    editBatchDraft(A, tooltip, 'en', 'Upcoming wording', 'alice', batch);
    editBatchDraft(B, tooltip, 'en', 'Another batch', 'alice', batch);
    await current.getState().flush();
    await batch.getState().flush();
    expect(Object.keys(current.getState().drafts)).toEqual(['123']);
    expect(current.getState().drafts[123].next.text.en?.text).toBe('Current wording');
    expect(draftsOfBatch(batch.getState().drafts, A).get(123)?.next.text.en?.text).toBe(
      'Upcoming wording',
    );
    expect(draftsOfBatch(batch.getState().drafts, B).get(123)?.next.text.en?.text).toBe(
      'Another batch',
    );
    const currentDisk = (await rawRead(userDraftKey(user))) as Drafts;
    expect(Object.keys(currentDisk)).toEqual(['123']);
    expect(Object.keys((await rawRead(batchBucketKey(user))) as Drafts).sort()).toEqual([
      batchDraftKey(A, 123),
      batchDraftKey(B, 123),
    ]);
    // Discarding one destination leaves the others.
    discardBatchDraft(A, 123, batch);
    await batch.getState().flush();
    expect(Object.keys(batch.getState().drafts)).toEqual([batchDraftKey(B, 123)]);
    expect(current.getState().drafts[123]).toBeDefined();
    // Returning a batch draft to its base drops it, as Current does.
    editBatchDraft(B, tooltip, 'en', english.text, 'alice', batch);
    updateBatchDrafts(
      A,
      [{ base: tooltip, update: (next) => ({ ...next, associated: [5] }) }],
      batch,
    );
    expect(Object.keys(batch.getState().drafts)).toEqual([batchDraftKey(A, 123)]);
    await batch.getState().flush();
    // The Current bucket is byte-for-byte what the Current store wrote, untouched by batch writes.
    expect(await rawRead(userDraftKey(user))).toEqual(currentDisk);
    stop();
  });

  it('reload hydrates both destinations; account switches follow the Current store', async () => {
    const alice = nextAccount();
    const bob = nextAccount();
    const first = await tab(alice, `reload-1-${alice}`);
    first.current.getState().edit(tooltip, 'en', 'Current', 'alice');
    editBatchDraft(A, tooltip, 'en', 'Upcoming', 'alice', first.batch);
    await first.current.getState().flush();
    await first.batch.getState().flush();
    first.stop();

    const reloaded = await tab(alice, `reload-2-${alice}`);
    expect(reloaded.current.getState().drafts[123].next.text.en?.text).toBe('Current');
    expect(reloaded.batch.getState().drafts[batchDraftKey(A, 123)].next.text.en?.text).toBe(
      'Upcoming',
    );
    expect(reloaded.batch.getState().owner).toBe(alice);

    await reloaded.current.getState().activate(bob);
    await reloaded.batch.getState().hydrate();
    expect(reloaded.batch.getState().owner).toBe(bob);
    expect(reloaded.batch.getState().drafts).toEqual({});
    await reloaded.current.getState().activate(alice);
    await reloaded.batch.getState().hydrate();
    expect(Object.keys(reloaded.batch.getState().drafts)).toEqual([batchDraftKey(A, 123)]);

    // Signed out there is no batch destination: nothing to read, and edits are refused.
    await reloaded.current.getState().activate(null);
    await reloaded.batch.getState().hydrate();
    expect(reloaded.batch.getState().drafts).toEqual({});
    expect(() => editBatchDraft(A, tooltip, 'en', 'x', 'anon', reloaded.batch)).toThrow('Sign in');
    expect(() => discardBatchDraft(A, 123, reloaded.batch)).toThrow('Sign in');
    reloaded.stop();
  });

  it('a batch store hydrating before the link refuses edits until an account is active', async () => {
    const batch = createBatchDraftStore(createBatchDraftStorage('unlinked'));
    expect(() => editBatchDraft(A, tooltip, 'en', 'x', 'anon', batch)).toThrow('recovery');
    await batch.getState().hydrate();
    expect(() => editBatchDraft(A, tooltip, 'en', 'x', 'anon', batch)).toThrow('Sign in');
  });

  it('cross-tab: a batch write flags only the batch store, and Reload or Keep mine recovers', async () => {
    const user = nextAccount();
    const one = await tab(user, `x-1-${user}`);
    const two = await tab(user, `x-2-${user}`);
    editBatchDraft(A, tooltip, 'en', 'From tab two', 'bob', two.batch);
    await two.batch.getState().flush();
    await settle();
    expect(one.batch.getState().external).toBe(true);
    expect(one.current.getState().external).toBe(false);

    // Tab one writes without reloading: the compare-and-set refuses and keeps its draft.
    editBatchDraft(A, { ...tooltip, hash: 124 }, 'en', 'From tab one', 'alice', one.batch);
    await one.batch.getState().flush();
    expect(one.batch.getState().error).toContain('Another tab changed local drafts');
    expect(one.batch.getState().drafts[batchDraftKey(A, 124)]).toBeDefined();

    await one.batch.getState().reloadFromStorage(reconcileDrafts);
    expect(one.batch.getState().error).toBeNull();
    expect(Object.keys(one.batch.getState().drafts).sort()).toEqual([
      batchDraftKey(A, 123),
      batchDraftKey(A, 124),
    ]);
    expect(Object.keys((await rawRead(batchBucketKey(user))) as Drafts).sort()).toEqual([
      batchDraftKey(A, 123),
      batchDraftKey(A, 124),
    ]);

    // Keep mine: tab two's next batch write wins over what tab one stored.
    await settle();
    expect(two.batch.getState().external).toBe(true);
    discardBatchDraft(A, 123, two.batch);
    await two.batch.getState().flush();
    expect(two.batch.getState().error).toContain('Another tab');
    await two.batch.getState().keepMine();
    expect(two.batch.getState().error).toBeNull();
    expect(Object.keys((await rawRead(batchBucketKey(user))) as Drafts)).toEqual([]);
    // Current drafts never saw any of it.
    expect(one.current.getState().drafts).toEqual({});
    expect(two.current.getState().external).toBe(false);
    one.stop();
    two.stop();
  });
});

describe('STATE SWEEP: saves returning after a destination switch', () => {
  const initial = useDraftStore.getState();
  const retry = vi.fn();
  let batch: BatchDraftStore;
  let fixture: BatchFixture;
  const mine: Tooltip = { ...tooltip, text: { en: { ...english, text: 'Mine' } } };
  beforeEach(async () => {
    retry.mockClear();
    useDraftStore.setState({ ...initial, hydrated: true, retry });
    useDataStore.setState({ data: editorData() });
    batch = createBatchDraftStore(createBatchDraftStorage(`switch-${nextAccount()}`));
    await batch.getState().activate(nextAccount());
    fixture = createBatchFixture({
      current: { 123: tooltip },
      user: { id: 1, login: 'alice', role: 'editor' },
    });
  });
  afterEach(() => useDraftStore.setState(initial));

  it('a Current save returning after the switch to a batch leaves the batch draft alone', () => {
    replaceDraft(tooltip, mine);
    const submitted = useDraftStore.getState().drafts;
    // Switch: the same hash gets a batch draft while the Current save is in flight.
    editBatchDraft(A, tooltip, 'en', 'Upcoming', 'alice', batch);
    const before = batch.getState().drafts;
    acceptSaved(submitted, [mine], 'saved-commit');
    expect(useDraftStore.getState().drafts).toEqual({});
    expect(batch.getState().drafts).toBe(before);
  });

  it('a batch save returning after the switch to Current touches only that batch', async () => {
    const created = await post(fixture, '/batches', { name: 'December' });
    const id = (created.body.batch as { id: string }).id;
    editBatchDraft(id, tooltip, 'en', 'Upcoming', 'alice', batch);
    editBatchDraft(B, tooltip, 'en', 'Other batch', 'alice', batch);
    const submitted = Object.fromEntries(
      [...draftsOfBatch(batch.getState().drafts, id)].map(([hash, draft]) => [
        batchDraftKey(id, hash),
        draft,
      ]),
    );
    // Switch back to Current and edit the same hash there while the batch save is in flight.
    replaceDraft(tooltip, mine);
    const currentBefore = useDraftStore.getState().drafts;
    const bundleBefore = useDataStore.getState().data;
    const saved = await post(fixture, `/batches/${id}/save`, {
      revision: 1,
      ...saveBody(submitted),
    });
    expect(saved.status).toBe(200);
    acceptBatchSaved(id, submitted, saved.body.members, batch);
    expect(Object.keys(batch.getState().drafts)).toEqual([batchDraftKey(B, 123)]);
    expect(useDraftStore.getState().drafts).toBe(currentBefore);
    expect(useDataStore.getState().data).toBe(bundleBefore);
    expect(retry).toHaveBeenCalledTimes(1); // the Current replaceDraft only
  });

  it('a batch draft edited during its save is rebased on the stored proposal', async () => {
    const created = await post(fixture, '/batches', { name: 'December' });
    const id = (created.body.batch as { id: string }).id;
    const withFr = { ...tooltip, text: { ...tooltip.text } };
    editBatchDraft(id, withFr, 'en', 'Upcoming', 'alice', batch);
    const submitted = { ...batch.getState().drafts };
    updateBatchDrafts(
      id,
      [{ base: tooltip, update: (next) => ({ ...next, associated: [7] }) }],
      batch,
    );
    const saved = await post(fixture, `/batches/${id}/save`, {
      revision: 1,
      ...saveBody(submitted),
    });
    acceptBatchSaved(id, submitted, saved.body.members, batch);
    const draft = batch.getState().drafts[batchDraftKey(id, 123)];
    expect(draft.base).toEqual(fixture.members.get(id)?.get(123)?.proposed);
    expect(draft.next.text.en?.text).toBe('Upcoming');
    expect(draft.next.associated).toEqual([7]);
  });

  it('refuses a response for another batch or one that omits a member, keeping the drafts', () => {
    editBatchDraft(A, tooltip, 'en', 'Upcoming', 'alice', batch);
    const submitted = { ...batch.getState().drafts };
    expect(() => acceptBatchSaved(B, submitted, [], batch)).toThrow('not in batch');
    expect(() => acceptBatchSaved(A, submitted, [], batch)).toThrow('omitted');
    expect(batch.getState().drafts).toEqual(submitted);
  });

  it('conflict recovery: a 409 keeps the draft; a rebase on the new base saves', async () => {
    const created = await post(fixture, '/batches', { name: 'December' });
    const id = (created.body.batch as { id: string }).id;
    editBatchDraft(id, tooltip, 'en', 'Upcoming', 'alice', batch);
    // Someone saved Current meanwhile: the add's base no longer matches current at head.
    const moved = { ...tooltip, text: { en: { ...english, text: 'Moved' } } };
    fixture.setCurrent(123, moved);
    const submitted = { ...batch.getState().drafts };
    const refused = await post(fixture, `/batches/${id}/save`, {
      revision: 1,
      ...saveBody(submitted),
    });
    expect(refused.status).toBe(409);
    expect(batch.getState().drafts).toEqual(submitted);
    const draft = submitted[batchDraftKey(id, 123)];
    replaceBatchDraft(id, moved, { ...draft.next, hash: 123 }, true, batch);
    expect(batch.getState().drafts[batchDraftKey(id, 123)].base).toEqual(moved);
    const rebased = { ...batch.getState().drafts };
    const saved = await post(fixture, `/batches/${id}/save`, { revision: 1, ...saveBody(rebased) });
    expect(saved.status).toBe(200);
    acceptBatchSaved(id, rebased, saved.body.members, batch);
    expect(batch.getState().drafts).toEqual({});
  });
});

describe('fixture Worker batch routes', () => {
  const editor = { id: 1, login: 'alice', role: 'editor' as const };
  async function seeded() {
    const fixture = createBatchFixture({
      current: { 123: tooltip, 124: { ...tooltip, hash: 124 } },
      user: editor,
    });
    const id = (
      (await post(fixture, '/batches', { name: 'December' })).body.batch as { id: string }
    ).id;
    const next = { ...tooltip, text: { en: { ...english, text: 'Upcoming' } } };
    const saved = await post(fixture, `/batches/${id}/save`, {
      revision: 1,
      changes: [{ hash: 123, base: tooltip, next }],
    });
    expect(saved.status).toBe(200);
    return { fixture, id, next };
  }

  it('answers 503 on every batch route while the switch is OFF, and lists batches when ON', async () => {
    const { fixture, id } = await seeded();
    fixture.setEnabled(false);
    expect((await fixture.fetch('https://worker.test/batches')).status).toBe(503);
    expect((await post(fixture, `/batches/${id}/save`, { revision: 2, changes: [] })).status).toBe(
      503,
    );
    fixture.setEnabled(true);
    const list = (await (await fixture.fetch('https://worker.test/batches')).json()) as {
      head: string;
      index: { batches: { id: string; hashes: number[]; revision: number }[] };
    };
    expect(list.index.batches).toEqual([
      expect.objectContaining({ id, hashes: [123], revision: 2 }),
    ]);
    const member = await fixture.fetch(
      `https://raw.githubusercontent.com/o/editor-data/${list.head}/schedule/batches/${id}/tooltips/123.json`,
    );
    expect(member.status).toBe(200);
  });

  it('enforces revisions, Q2, Q3, translator languages, scheduled edits, and the claim', async () => {
    const { fixture, id, next } = await seeded();
    expect((await post(fixture, `/batches/${id}/save`, { revision: 1, changes: [] })).status).toBe(
      409,
    );
    const other = (
      (await post(fixture, '/batches', { name: 'Later' })).body.batch as { id: string }
    ).id;
    const q2 = await post(fixture, `/batches/${other}/save`, {
      revision: 1,
      changes: [{ hash: 123, base: tooltip, next }],
    });
    expect(q2).toMatchObject({ status: 409, body: { error: 'Tooltip 123 is in December' } });

    fixture.setUser({ id: 2, login: 'trial', role: 'trial' });
    expect((await fixture.fetch('https://worker.test/batches')).status).toBe(403);
    fixture.setUser({ id: 3, login: 'tr', role: 'translator', languages: ['fr'] });
    const french = { ...next, text: { ...next.text, fr: { ...english, text: 'Bientôt' } } };
    const german = { ...next, text: { ...next.text, de: { ...english, text: 'Bald' } } };
    expect(
      (
        await post(fixture, `/batches/${id}/save`, {
          revision: 2,
          changes: [{ hash: 123, base: next, next: german }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(fixture, `/batches/${id}/save`, {
          revision: 2,
          changes: [{ hash: 124, base: { ...tooltip, hash: 124 }, next: { ...french, hash: 124 } }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(fixture, `/batches/${id}/save`, {
          revision: 2,
          changes: [{ hash: 123, base: next, next: french }],
        })
      ).status,
    ).toBe(200);

    fixture.setUser(editor);
    const scheduled = await post(fixture, `/batches/${id}/schedule`, {
      revision: 3,
      notBefore: '2026-12-01T17:00:00.000Z',
      zone: 'Europe/Berlin',
    });
    expect(scheduled.body.batch).toMatchObject({ status: 'scheduled', contentRevision: 1 });
    const english2 = { ...french, text: { ...french.text, en: { ...english, text: 'Changed' } } };
    expect(
      await post(fixture, `/batches/${id}/save`, {
        revision: 4,
        changes: [{ hash: 123, base: french, next: english2 }],
      }),
    ).toMatchObject({ status: 409, body: { error: 'Unschedule to edit' } });
    fixture.claim(id);
    expect(
      await post(fixture, `/batches/${id}/save`, {
        revision: 5,
        changes: [{ hash: 123, base: french, next: french }],
      }),
    ).toMatchObject({ status: 409, body: { error: 'Publishing started' } });
    expect(await post(fixture, `/batches/${id}/unschedule`, { revision: 5 })).toMatchObject({
      status: 409,
      body: { error: 'Publishing started' },
    });
  });
});
