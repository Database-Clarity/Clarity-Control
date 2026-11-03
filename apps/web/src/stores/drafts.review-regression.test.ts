// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Drafts, DraftStorage } from '../services/draftStorage';
import { createDraftStore } from './drafts';

it('review regression: preserves unowned copy when an identical account edit fails during adoption read', async () => {
  sessionStorage.clear();
  const base: Tooltip = {
    hash: 10,
    associated: [],
    text: { en: { text: 'Original', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } },
  };
  let unowned: Drafts = { 10: { base, next: { ...base, associated: [3] } } };
  let release!: (drafts: Drafts) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<Drafts>((resolve) => {
    release = resolve;
  });
  let delayRead = false;
  const account: DraftStorage = {
    read: async () => ({}),
    write: async () => {
      throw new Error('quota');
    },
  };
  const storage: DraftStorage = {
    read: async () => {
      if (delayRead) {
        started();
        return gate;
      }
      return structuredClone(unowned);
    },
    write: async (drafts) => {
      unowned = structuredClone(drafts);
    },
    forUser: () => account,
  };
  const store = createDraftStore(storage);
  await store.getState().activate(7);
  delayRead = true;
  const adopting = store.getState().adopt();
  await reading;
  store.getState().updateDraft(base, (next) => ({ ...next, associated: [3] }));
  await store.getState().flush();
  expect(store.getState().error).toContain('quota');
  release(structuredClone(unowned));
  await adopting;
  // The account's identical copy only exists in memory; deleting this loses the only durable copy.
  expect(unowned[10]).toBeDefined();
});

it.each([false, true])(
  'waits for an identical edit queued during the read (failure: %s)',
  async (fail) => {
    sessionStorage.clear();
    const base: Tooltip = { hash: 10, associated: [], text: {} };
    let unowned: Drafts = { 10: { base, next: { ...base, associated: [3] } } };
    let saved: Drafts = {};
    let releaseRead!: (drafts: Drafts) => void;
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const readGate = new Promise<Drafts>((resolve) => {
      releaseRead = resolve;
    });
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writing = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let delayRead = false;
    const store = createDraftStore({
      read: async () => {
        if (delayRead) {
          readStarted();
          return readGate;
        }
        return structuredClone(unowned);
      },
      write: async (drafts) => {
        // Cleanup must never run ahead of the account write's acknowledgment.
        expect(saved[10]).toEqual(unowned[10]);
        unowned = structuredClone(drafts);
      },
      forUser: () => ({
        read: async () => ({}),
        write: async (drafts) => {
          writeStarted();
          await writeGate;
          if (fail) throw new Error('quota');
          saved = structuredClone(drafts);
        },
      }),
    });
    await store.getState().activate(7);
    delayRead = true;
    const adopting = store.getState().adopt();
    await reading;
    store.getState().updateDraft(base, (next) => ({ ...next, associated: [3] }));
    await writing;
    releaseRead(structuredClone(unowned));
    // Drain microtasks while the account write is still blocked.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(unowned[10]).toBeDefined();
    releaseWrite();
    await adopting;
    expect(Boolean(unowned[10])).toBe(fail);
    expect(Boolean(saved[10])).toBe(!fail);
  },
);

it.each([false, true])(
  'does not update a new account after delayed cleanup (failure: %s)',
  async (fail) => {
    sessionStorage.clear();
    const base: Tooltip = { hash: 10, associated: [], text: {} };
    let unowned: Drafts = { 10: { base, next: { ...base, associated: [3] } } };
    const accounts = new Map<string, Drafts>();
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createDraftStore({
      read: async () => structuredClone(unowned),
      write: async (drafts) => {
        started();
        await gate;
        if (fail) throw new Error('cleanup failed');
        unowned = structuredClone(drafts);
      },
      forUser: (id) => ({
        read: async () => structuredClone(accounts.get(id) ?? {}),
        write: async (drafts) => {
          accounts.set(id, structuredClone(drafts));
        },
      }),
    });
    await store.getState().activate(7);
    const adopting = store.getState().adopt();
    await writing;
    expect(accounts.get('7')?.[10]).toBeDefined();
    const switching = store.getState().activate(8);
    release();
    await Promise.all([adopting, switching]);
    expect(store.getState().owner).toBe('8');
    expect(store.getState().error).toBeNull();
    expect(sessionStorage.getItem('clarity-drafts-keep-separate:7')).toBeNull();
    expect(Boolean(unowned[10])).toBe(fail);
  },
);
