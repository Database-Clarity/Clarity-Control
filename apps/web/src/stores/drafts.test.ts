// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createDraftStore } from './drafts';
import {
  createIndexedDbStorage,
  draftStorage,
  draftsSchema,
  type Drafts,
  type DraftStorage,
} from '../services/draftStorage';

it.each(['addition', 'deletion', 'same-tooltip'] as const)(
  'review probe: failed account recovery preserves concurrent %s through real IndexedDB CAS',
  async (mode) => {
    const accountId = `review-recovery-${mode}`;
    const rawA = createIndexedDbStorage('tooltips', `review-tab-a-${mode}`);
    const accountA = rawA.forUser!(accountId);
    let fail = false;
    const a = createDraftStore({
      ...rawA,
      forUser: (id) =>
        id === accountId
          ? {
              ...accountA,
              write: async (drafts) => {
                if (fail) throw new Error('Quota review probe');
                await accountA.write(drafts);
              },
            }
          : rawA.forUser!(id),
    });
    await a.getState().activate(accountId);
    a.getState().edit(base, 'en', 'stored before switch', 'seed');
    await a.getState().flush();
    const b = createDraftStore(createIndexedDbStorage('tooltips', `review-tab-b-${mode}`));
    await b.getState().activate(accountId);
    fail = true;
    a.getState().edit({ ...base, hash: 20 }, 'en', 'unsaved local edit', 'alice');
    await a.getState().flush();
    expect(a.getState().error).toContain('Quota');
    await a.getState().activate(`review-other-${mode}`);
    if (mode !== 'deletion')
      b.getState().edit(
        { ...base, hash: mode === 'addition' ? 30 : 20 },
        'en',
        'other tab edit',
        'bob',
      );
    else b.getState().discard(10);
    await b.getState().flush();
    expect(b.getState().error).toBeNull();
    await a.getState().activate(accountId);
    expect(a.getState().drafts[20]?.next.text.en?.text).toContain('unsaved local edit');
    fail = false;
    a.getState().retry();
    await a.getState().flush();
    expect(a.getState().error).toBeNull();
    const disk = await createIndexedDbStorage().forUser!(accountId).read();
    if (mode === 'addition') expect(disk[30]?.next.text.en?.text).toBe('other tab edit');
    else if (mode === 'deletion') expect(disk[10]).toBeUndefined();
    else {
      expect(disk[20]?.next.text.en?.text).toContain('unsaved local edit');
      expect(disk[20]?.next.text.en?.text).toContain('other tab edit');
    }
  },
);

it('recovers against an earlier successful queued write before a later write failed', async () => {
  const raw = createIndexedDbStorage('tooltips', 'queued-recovery-a');
  const account = raw.forUser!('queued-recovery');
  const a = createDraftStore({
    ...raw,
    forUser: (id) =>
      id === 'queued-recovery'
        ? {
            ...account,
            write: async (drafts) => {
              if (drafts[20]) throw new Error('Quota');
              await account.write(drafts);
            },
          }
        : raw.forUser!(id),
  });
  await a.getState().activate('queued-recovery');
  a.getState().edit(base, 'en', 'stored by first queued write', 'alice');
  a.getState().edit({ ...base, hash: 20 }, 'en', 'unsaved second write', 'alice');
  await a.getState().flush();
  await a.getState().activate('elsewhere');
  const b = createDraftStore(createIndexedDbStorage('tooltips', 'queued-recovery-b'));
  await b.getState().activate('queued-recovery');
  b.getState().discard(10);
  await b.getState().flush();
  await a.getState().activate('queued-recovery');
  expect(a.getState().drafts[10]).toBeUndefined();
  expect(a.getState().drafts[20]?.next.text.en?.text).toBe('unsaved second write');
});

const base: Tooltip = {
  hash: 10,
  text: { en: { text: 'Original', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } },
  associated: [],
};
function memory(): DraftStorage {
  let value: Drafts = {};
  return {
    async read() {
      return structuredClone(value);
    },
    async write(drafts) {
      value = structuredClone(drafts);
    },
  };
}

describe('local drafts', () => {
  it('persists association-only drafts, preserves the base and retains them when text is undone', async () => {
    const storage = memory();
    const store = createDraftStore(storage);
    expect(() => store.getState().updateDraft(base, (next) => next)).toThrow('recovery');
    await store.getState().hydrate();
    store.getState().updateDraft(base, (next) => ({ ...next, associated: [30, 20] }));
    store.getState().edit(base, 'en', 'Changed', 'alice');
    store.getState().edit(base, 'en', 'Original', 'alice');
    await store.getState().flush();
    const recovered = createDraftStore(storage);
    await recovered.getState().hydrate();
    expect(recovered.getState().drafts[10]).toEqual({
      base,
      next: { ...base, associated: [30, 20] },
    });
    store
      .getState()
      .updateDraft({ ...base, associated: [99] }, (next) => ({ ...next, associated: [] }));
    expect(store.getState().drafts).toEqual({});
    expect(() => store.getState().updateDraft(base, (next) => ({ ...next, hash: 11 }))).toThrow(
      'hash',
    );
    await store.getState().flush();
  });
  it('recovers drafts from IndexedDB after recreating the store and supports discard', async () => {
    const first = createDraftStore(draftStorage);
    await first.getState().hydrate();
    first.getState().edit(base, 'en', 'Local edit', 'alice');
    await first.getState().flush();
    const second = createDraftStore(draftStorage);
    await second.getState().hydrate();
    expect(second.getState().drafts[10]).toMatchObject({
      base,
      next: { text: { en: { text: 'Local edit' } } },
    });
    second.getState().discard(10);
    await second.getState().flush();
    const third = createDraftStore(draftStorage);
    await third.getState().hydrate();
    expect(third.getState().drafts).toEqual({});
  });
  it('keeps the original base when server data changes and serializes rapid writes', async () => {
    const storage = memory();
    const store = createDraftStore(storage);
    await store.getState().hydrate();
    store.getState().edit(base, 'en', 'one', 'alice');
    store.getState().edit({ ...base, associated: [30] }, 'en', 'two', 'alice');
    await store.getState().flush();
    const saved = await storage.read();
    expect(saved[10].base).toEqual(base);
    expect(saved[10].next.text.en?.text).toBe('two');
    expect(store.getState().pending).toBe(0);
  });
  it('blocks editing before recovery and never overwrites unread drafts after a read failure', async () => {
    const write = vi.fn();
    const store = createDraftStore({ read: () => Promise.reject(new Error('blocked')), write });
    expect(() => store.getState().edit(base, 'en', 'oops', '')).toThrow('recovery');
    await store.getState().hydrate();
    expect(store.getState().hydrated).toBe(false);
    expect(store.getState().error).toContain('blocked');
    expect(write).not.toHaveBeenCalled();
  });
  it('retains memory and visibly reports write failure, then retries', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    const store = createDraftStore({ read: async () => ({}), write });
    await store.getState().hydrate();
    store.getState().edit(base, 'en', 'Do not lose this', '');
    await store.getState().flush();
    expect(store.getState().error).toContain('quota');
    expect(store.getState().drafts[10].next.text.en?.text).toBe('Do not lose this');
    store.getState().retry();
    await store.getState().flush();
    expect(store.getState().error).toBeNull();
  });
  it('restores base metadata when reverting a language while retaining other language edits', async () => {
    const store = createDraftStore(memory());
    await store.getState().hydrate();
    store.getState().edit(base, 'en', 'Changed', 'alice');
    store.getState().edit(base, 'de', 'Deutsch', 'alice');
    store.getState().edit(base, 'en', 'Original', 'alice');
    expect(store.getState().drafts[10].next.text.en).toEqual(base.text.en);
    store.getState().edit(base, 'de', '', 'alice');
    expect(store.getState().drafts).toEqual({});
    await store.getState().flush();
  });
  it('rejects corrupt/mismatched stored drafts with the core schema', () => {
    expect(draftsSchema.safeParse({ 11: { base, next: base } }).success).toBe(false);
    expect(
      draftsSchema.safeParse({ 10: { base, next: { ...base, text: { xx: {} } } } }).success,
    ).toBe(false);
  });
  it('refuses to overwrite drafts changed by another tab', async () => {
    const first = createIndexedDbStorage();
    const second = createIndexedDbStorage();
    await first.read();
    await second.read();
    await first.write({ 10: { base, next: base } });
    await expect(second.write({})).rejects.toThrow('Another tab');
    expect(await first.read()).toEqual({ 10: { base, next: base } });
    await first.write({});
  });
});

/** In-memory buckets mirroring IndexedDB: the storage is the unowned bucket, forUser gives accounts. */
function buckets() {
  const values = new Map<string, Drafts>();
  const make = (key: string): DraftStorage => ({
    async read() {
      return structuredClone(values.get(key) ?? {});
    },
    async write(drafts) {
      values.set(key, structuredClone(drafts));
    },
    ...(key === 'unowned' ? { forUser: (id: string) => make(`user:${id}`) } : {}),
  });
  return { storage: make('unowned'), values };
}
const other: Tooltip = {
  hash: 20,
  text: { en: { text: 'Other', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } },
  associated: [],
};

describe('drafts belong to one account', () => {
  it.each(['discard', 'change'] as const)(
    'keeps identical unowned drafts when another tab does %s before adoption',
    async (action) => {
      sessionStorage.clear();
      const storage = createIndexedDbStorage();
      const identical = { 10: { base, next: { ...base, associated: [3] } } };
      await storage.read();
      await storage.write(identical);
      const account = storage.forUser!('adoption-two-tabs');
      await account.read();
      await account.write(identical);
      const first = createDraftStore(storage);
      const second = createDraftStore(createIndexedDbStorage());
      await first.getState().activate('adoption-two-tabs');
      await second.getState().activate('adoption-two-tabs');
      if (action === 'discard') second.getState().discard(10);
      else second.getState().updateDraft(base, (next) => ({ ...next, associated: [4] }));
      await second.getState().flush();

      expect(await first.getState().adopt()).toEqual({ adopted: 0, left: 1 });
      expect(first.getState().error).toContain('Another tab');
      expect(first.getState().unowned).toBe(1);
      expect(sessionStorage.getItem('clarity-drafts-keep-separate:adoption-two-tabs')).toBeNull();
      expect(await storage.read()).toEqual(identical);
      const disk = await account.read();
      expect(disk).toEqual(
        action === 'discard' ? {} : { 10: { base, next: { ...base, associated: [4] } } },
      );
      await account.write({});
      await storage.write({});
      sessionStorage.clear();
    },
  );

  it('hides, keeps and restores drafts per account without ever mixing them', async () => {
    const { storage, values } = buckets();
    const store = createDraftStore(storage);
    await store.getState().activate(1);
    store.getState().edit(base, 'en', 'alice draft', 'alice');
    await store.getState().flush();

    await store.getState().activate(2);
    expect(store.getState().drafts).toEqual({});
    store.getState().edit(other, 'en', 'bob draft', 'bob');
    await store.getState().flush();
    expect(Object.keys(store.getState().drafts)).toEqual(['20']);

    await store.getState().activate(null);
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().unowned).toBe(0);

    await store.getState().activate(1);
    expect(store.getState().drafts[10].next.text.en?.text).toBe('alice draft');
    expect(store.getState().drafts[20]).toBeUndefined();
    expect(Object.keys(values.get('user:2') ?? {})).toEqual(['20']);
    expect(Object.keys(values.get('user:1') ?? {})).toEqual(['10']);
  });

  it('writes an in-flight edit to the account that made it, even after a switch', async () => {
    const { storage, values } = buckets();
    const slow = storage.forUser!('1');
    const write = slow.write.bind(slow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store = createDraftStore({
      ...storage,
      forUser: (id) =>
        id === '1'
          ? { ...slow, write: async (drafts) => (await gate, write(drafts)) }
          : storage.forUser!(id),
    });
    await store.getState().activate(1);
    store.getState().edit(base, 'en', 'late write', 'alice');
    const switched = store.getState().activate(2);
    release();
    await switched;
    await store.getState().flush();
    expect(store.getState().drafts).toEqual({});
    expect(Object.keys(values.get('user:1') ?? {})).toEqual(['10']);
    expect(values.get('user:2')).toBeUndefined();
  });

  it('never attributes unowned or legacy drafts silently, and adoption keeps every draft', async () => {
    const { storage, values } = buckets();
    values.set('unowned', {
      10: { base, next: { ...base, text: { en: { ...base.text.en!, text: 'legacy' } } } },
    });
    const store = createDraftStore(storage);
    await store.getState().activate(null);
    expect(Object.keys(store.getState().drafts)).toEqual(['10']); // still the signed-out view

    await store.getState().activate(7);
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().unowned).toBe(1);
    expect(values.get('user:7')).toBeUndefined();

    const result = await store.getState().adopt();
    expect(result).toEqual({ adopted: 1, left: 0 });
    expect(store.getState().unowned).toBe(0);
    expect(store.getState().drafts[10].next.text.en?.text).toBe('legacy');
    expect(values.get('user:7')?.[10]).toBeDefined();
    expect(values.get('unowned')).toEqual({});
    sessionStorage.clear();
  });

  it('keeps conflicting drafts in both places instead of overwriting the account draft', async () => {
    const { storage, values } = buckets();
    values.set('unowned', {
      10: { base, next: { ...base, text: { en: { ...base.text.en!, text: 'signed out' } } } },
      20: { base: other, next: { ...other, text: { en: { ...other.text.en!, text: 'also' } } } },
    });
    values.set('user:7', {
      10: { base, next: { ...base, text: { en: { ...base.text.en!, text: 'mine' } } } },
    });
    const store = createDraftStore(storage);
    await store.getState().activate(7);
    expect(store.getState().unowned).toBe(2);
    expect(await store.getState().adopt()).toEqual({ adopted: 1, left: 1 });
    expect(store.getState().drafts[10].next.text.en?.text).toBe('mine');
    expect(store.getState().drafts[20].next.text.en?.text).toBe('also');
    expect(Object.keys(values.get('unowned') ?? {})).toEqual(['10']);
    sessionStorage.clear();
  });

  it('keeps unowned drafts untouched when the account copy cannot be stored', async () => {
    const { storage, values } = buckets();
    values.set('unowned', { 10: { base, next: { ...base, associated: [3] } } });
    const account = storage.forUser!('7');
    const store = createDraftStore({
      ...storage,
      forUser: () => ({ ...account, write: () => Promise.reject(new Error('quota')) }),
    });
    await store.getState().activate(7);
    await store.getState().adopt();
    expect(store.getState().error).toContain('NOT safely stored');
    expect(values.get('unowned')?.[10]).toBeDefined();
    sessionStorage.clear();
  });

  it('can keep unowned drafts separate and does not ask again this session', async () => {
    const { storage, values } = buckets();
    values.set('unowned', { 10: { base, next: { ...base, associated: [3] } } });
    const store = createDraftStore(storage);
    await store.getState().activate(7);
    expect(store.getState().unowned).toBe(1);
    store.getState().keepSeparate();
    expect(store.getState().unowned).toBe(0);
    await store.getState().activate(null);
    await store.getState().activate(7);
    expect(store.getState().unowned).toBe(0);
    expect(store.getState().drafts).toEqual({});
    expect(values.get('unowned')?.[10]).toBeDefined();
    sessionStorage.clear();
  });

  it('isolates accounts in IndexedDB and leaves the legacy key as the unowned bucket', async () => {
    const storage = createIndexedDbStorage();
    await storage.read();
    await storage.write({ 10: { base, next: { ...base, associated: [1] } } });
    const alice = storage.forUser!('1');
    await alice.read();
    await alice.write({ 20: { base: other, next: { ...other, associated: [2] } } });
    const fresh = createIndexedDbStorage();
    expect(Object.keys(await fresh.read())).toEqual(['10']);
    expect(Object.keys(await fresh.forUser!('1').read())).toEqual(['20']);
    expect(await fresh.forUser!('2').read()).toEqual({});
    await fresh.forUser!('1').write({});
    await fresh.write({});
  });

  it('refuses to adopt while draft storage is failing, so no only-copy is deleted', async () => {
    const { storage, values } = buckets();
    values.set('unowned', { 10: { base, next: { ...base, associated: [3] } } });
    const account = storage.forUser!('7');
    const store = createDraftStore({
      ...storage,
      forUser: () => ({ ...account, write: () => Promise.reject(new Error('quota')) }),
    });
    await store.getState().activate(7);
    store.getState().updateDraft(base, (next) => ({ ...next, associated: [3] }));
    await store.getState().flush();
    expect(store.getState().error).toContain('NOT safely stored');
    await expect(store.getState().adopt()).rejects.toThrow('Fix draft storage');
    expect(values.get('unowned')?.[10]).toBeDefined();
    sessionStorage.clear();
  });

  it('refuses to adopt when an account write queued before the click fails meanwhile', async () => {
    const { storage, values } = buckets();
    values.set('unowned', { 10: { base, next: { ...base, associated: [3] } } });
    const account = storage.forUser!('7');
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = () => reject(new Error('quota'))));
    const store = createDraftStore({
      ...storage,
      forUser: () => ({ ...account, write: () => gate }),
    });
    await store.getState().activate(7);
    // Identical to the unowned draft, so adopting would delete the only on-disk copy.
    store.getState().updateDraft(base, (next) => ({ ...next, associated: [3] }));
    const adopting = expect(store.getState().adopt()).rejects.toThrow('Fix draft storage');
    fail();
    await adopting;
    expect(values.get('unowned')?.[10]).toBeDefined();
    sessionStorage.clear();
  });

  it('keeps a failed write of the previous account separate from the next account', async () => {
    const { storage } = buckets();
    const alice = storage.forUser!('1');
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = () => reject(new Error('disk full'))));
    const store = createDraftStore({
      ...storage,
      forUser: (id) => (id === '1' ? { ...alice, write: () => gate } : storage.forUser!(id)),
    });
    await store.getState().activate(1);
    store.getState().edit(base, 'en', 'unsaved', 'alice');
    const switched = store.getState().activate(2);
    fail();
    await switched;
    await store.getState().flush();
    expect(store.getState().previousAccountError).toContain('disk full');
    expect(store.getState().previousAccountError).toContain('(1)');
    // The new account is healthy: its saves are not blocked and its load did not clear the notice.
    expect(store.getState().error).toBeNull();
    expect(store.getState().hydrated).toBe(true);
    store.getState().edit(other, 'en', 'bob draft', 'bob');
    await store.getState().flush();
    expect(store.getState().error).toBeNull();
    expect(store.getState().previousAccountError).toContain('disk full');
    store.getState().dismissPreviousAccountError();
    expect(store.getState().previousAccountError).toBeNull();
  });

  it('restores the latest failed snapshot on return, and clears recovery after retry', async () => {
    const { storage } = buckets();
    let fail = true;
    const account = storage.forUser!('1');
    const store = createDraftStore({
      ...storage,
      forUser: (id) =>
        id === '1'
          ? {
              ...account,
              write: async (drafts) => {
                if (fail) throw new Error('quota');
                await account.write(drafts);
              },
            }
          : storage.forUser!(id),
    });
    await store.getState().activate(1);
    store.getState().edit(base, 'en', 'first', 'alice');
    store.getState().edit(base, 'en', 'latest', 'alice');
    await store.getState().flush();
    await store.getState().activate(2);
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().previousAccountError).toContain('quota');
    await store.getState().activate(1);
    expect(store.getState().drafts[10]?.next.text.en?.text).toBe('latest');
    expect(store.getState().error).toContain('quota');
    fail = false;
    store.getState().retry();
    await store.getState().flush();
    expect(store.getState().error).toBeNull();
    await store.getState().activate(2);
    // A later storage snapshot must be authoritative once recovery has been stored.
    await account.write({});
    await store.getState().activate(1);
    expect(store.getState().drafts).toEqual({});
  });
});
