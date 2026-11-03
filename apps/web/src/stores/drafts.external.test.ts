// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { reconcileDrafts } from '../features/conflicts/rebase';
import { createDraftStore } from './drafts';
import type { Drafts, DraftStorage } from '../services/draftStorage';

const entry = (text: string) => ({
  text,
  updatedAt: '2026-10-01T00:00:00Z',
  updatedBy: 'owner',
});
const base: Tooltip = {
  hash: 10,
  text: { en: entry('one\ntwo\nthree\nfour\nfive') },
  associated: [],
};

/** A bucket two stores (two tabs) share, with the compare-and-set the IndexedDB storage has. */
function sharedBucket() {
  let value: Drafts = {};
  const listeners = new Set<{ tab: number; run: () => void }>();
  const tab = (id: number): DraftStorage => {
    let expected = JSON.stringify({});
    return {
      async read() {
        expected = JSON.stringify(value);
        return structuredClone(value);
      },
      async write(drafts) {
        if (JSON.stringify(value) !== expected)
          throw new Error('Another tab changed local drafts. Keep this tab open.');
        value = structuredClone(drafts);
        expected = JSON.stringify(value);
        for (const other of listeners) if (other.tab !== id) other.run();
      },
      subscribe(run) {
        const entry = { tab: id, run };
        listeners.add(entry);
        return () => void listeners.delete(entry);
      },
    };
  };
  return { tab, current: () => value };
}

async function twoTabs() {
  const bucket = sharedBucket();
  const a = createDraftStore(bucket.tab(1));
  const b = createDraftStore(bucket.tab(2));
  await a.getState().hydrate();
  await b.getState().hydrate();
  return { bucket, a, b };
}

describe('drafts changed in another tab', () => {
  it('flags the other tab, not the writer', async () => {
    const { a, b } = await twoTabs();
    a.getState().edit(base, 'en', 'A edit', 'alice');
    await a.getState().flush();
    expect(a.getState().external).toBe(false);
    expect(b.getState().external).toBe(true);
  });

  it('Reload merges the other tab with this tab, keeping both edits', async () => {
    const { bucket, a, b } = await twoTabs();
    // Both tabs start from the same stored draft.
    a.getState().edit(base, 'en', 'ONE\ntwo\nthree\nfour\nfive', 'alice');
    await a.getState().flush();
    await b.getState().reloadFromStorage(reconcileDrafts);
    expect(b.getState().external).toBe(false);
    // A edits the last line; B (unaware) edits the first line.
    a.getState().edit(base, 'en', 'ONE\ntwo\nthree\nfour\nFIVE', 'alice');
    await a.getState().flush();
    b.getState().edit(base, 'en', 'First\ntwo\nthree\nfour\nfive', 'bob');
    await b.getState().flush();
    expect(b.getState().error).toMatch(/Another tab changed/);
    await b.getState().reloadFromStorage(reconcileDrafts);
    expect(b.getState().error).toBeNull();
    expect(b.getState().drafts[10]!.next.text.en!.text).toBe('First\ntwo\nthree\nfour\nFIVE');
    expect(bucket.current()[10]!.next.text.en!.text).toBe('First\ntwo\nthree\nfour\nFIVE');
  });

  it('Keep mine overwrites what the other tab stored', async () => {
    const { bucket, a, b } = await twoTabs();
    a.getState().edit(base, 'en', 'from A', 'alice');
    await a.getState().flush();
    b.getState().edit(base, 'en', 'from B', 'bob');
    await b.getState().keepMine();
    expect(b.getState().external).toBe(false);
    expect(b.getState().error).toBeNull();
    expect(bucket.current()[10]!.next.text.en!.text).toBe('from B');
  });

  it('never writes while the answer is pending: the other tab text survives until chosen', async () => {
    const { bucket, a, b } = await twoTabs();
    a.getState().edit(base, 'en', 'from A', 'alice');
    await a.getState().flush();
    b.getState().edit(base, 'en', 'from B', 'bob');
    await b.getState().flush();
    expect(bucket.current()[10]!.next.text.en!.text).toBe('from A');
  });
});
