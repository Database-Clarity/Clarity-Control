// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createDraftStore } from '../stores/drafts';
import { createIndexedDbStorage } from './draftStorage';

const base: Tooltip = {
  hash: 10,
  text: { en: { text: 'one', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } },
  associated: [],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('draft storage channel (real IndexedDB, real BroadcastChannel)', () => {
  it('tells other tabs about a write, never the tab that made it', async () => {
    const mine = createIndexedDbStorage('tooltips:channel-a', 'tab-a');
    const other = createIndexedDbStorage('tooltips:channel-a', 'tab-b');
    const heardByMe = vi.fn();
    const heardByOther = vi.fn();
    const stopMine = mine.subscribe!(heardByMe);
    const stopOther = other.subscribe!(heardByOther);
    await mine.read();
    await mine.write({ 10: { base, next: base } });
    await settle();
    expect(heardByOther).toHaveBeenCalledTimes(1);
    expect(heardByMe).not.toHaveBeenCalled();
    stopMine();
    stopOther();
  });

  it('a store writing its own drafts (a conflict rebase, Reload, Keep mine) is never flagged external', async () => {
    const store = createDraftStore(createIndexedDbStorage('tooltips:channel-b', 'tab-c'));
    await store.getState().hydrate();
    store.getState().edit(base, 'en', 'two', 'alice');
    await store.getState().flush();
    await store.getState().keepMine();
    await store.getState().reloadFromStorage((_ancestor, mine) => mine);
    await settle();
    expect(store.getState().external).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  it('a second tab writing the same bucket flags the first', async () => {
    const first = createDraftStore(createIndexedDbStorage('tooltips:channel-c', 'tab-d'));
    const second = createDraftStore(createIndexedDbStorage('tooltips:channel-c', 'tab-e'));
    await first.getState().hydrate();
    await second.getState().hydrate();
    second.getState().edit(base, 'en', 'from the second tab', 'bob');
    await second.getState().flush();
    await settle();
    expect(first.getState().external).toBe(true);
    expect(second.getState().external).toBe(false);
  });
});
