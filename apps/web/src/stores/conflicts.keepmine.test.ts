// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { DraftStorage, Drafts } from '../services/draftStorage';

/**
 * Two tabs of one account over one draft database. Tab B is the app's own draft store (its
 * conflict rebase writes through replaceDraft); tab A is a second store that imports B's session.
 * A write notifies the other tab, like the IndexedDB storage's cross-tab signal.
 */
const shared = vi.hoisted(() => {
  const disk = new Map<string, unknown>();
  const listeners = new Set<{ tab: string; id: string; listener: () => void }>();
  const gate: { hold: Promise<void> | null } = { hold: null };
  const tab = (name: string, gated: boolean) => {
    const bucket = (id: string): DraftStorage => ({
      read: async () => structuredClone((disk.get(id) as Drafts | undefined) ?? {}),
      write: async (drafts) => {
        if (gated && gate.hold) await gate.hold;
        disk.set(id, structuredClone(drafts));
        for (const entry of listeners) if (entry.tab !== name && entry.id === id) entry.listener();
      },
      subscribe(listener) {
        const entry = { tab: name, id, listener };
        listeners.add(entry);
        return () => void listeners.delete(entry);
      },
    });
    return { ...bucket('signed-out'), forUser: bucket };
  };
  return { disk, gate, tab };
});
vi.mock('../services/draftStorage', async (original) => ({
  ...(await original<typeof import('../services/draftStorage')>()),
  draftStorage: shared.tab('B', false),
}));

const { conflictSessionKey, createConflictStore } = await import('./conflicts');
const { createDraftStore, useDraftStore } = await import('./drafts');

const entry = (text: string) => ({ text, updatedAt: '2026-01-01T10:00:00.000Z', updatedBy: 'a' });
const t = (en: string, name: string): Tooltip =>
  ({
    hash: 123,
    text: { en: entry(en) },
    associated: [],
    custom: { name, categoryId: 'c' },
  }) as Tooltip;
const base = t('top\nshared\nbottom', 'Base');
const head = t('top\ntheirs\nbottom', 'Theirs');
const mine = t('top\nmine\nbottom', 'Mine');

const saved = new Map<string, string>();
const memory = {
  get length() {
    return saved.size;
  },
  key: (i: number) => [...saved.keys()][i] ?? null,
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
const stops: (() => void)[] = [];
const conflictsFor = (drafts: typeof useDraftStore) => {
  const conflicts = createConflictStore({ drafts, storage: () => memory, applyHead: () => {} });
  stops.push(conflicts.getState().start());
  return conflicts;
};
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  saved.clear();
  shared.gate.hold = null;
  vi.restoreAllMocks();
});

let accounts = 0;
async function twoTabs() {
  let time = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => (time += 10));
  const account = `keep-${++accounts}`;
  const key = conflictSessionKey(account, 123);
  await useDraftStore.getState().activate(account);
  const b = conflictsFor(useDraftStore);
  b.getState().begin([{ hash: 123, base, head, next: mine, fields: ['text.en', 'custom'] }]);
  await useDraftStore.getState().flush();
  expect(memory.getItem(key)).not.toBeNull();
  const aDrafts = createDraftStore(shared.tab('A', true));
  await aDrafts.getState().activate(account);
  const a = conflictsFor(aDrafts);
  expect(a.getState().sessions[123]?.rows.custom).toBeNull();
  expect(a.getState().open()[0]).toMatchObject({ hash: 123, rows: 1 });
  return {
    account,
    key,
    a,
    aDrafts,
    b,
    disk: () => shared.disk.get(account) as Drafts,
    gate() {
      let release!: () => void;
      shared.gate.hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        shared.gate.hold = null;
        release();
      };
    },
  };
}
type Tabs = Awaited<ReturnType<typeof twoTabs>>;

/** Tab B resolves the tooltip: its draft goes, and with it the session. */
async function bResolves(tabs: Tabs) {
  useDraftStore.getState().discard(123);
  await useDraftStore.getState().flush();
  expect(tabs.b.getState().sessions).toEqual({});
  expect(memory.getItem(tabs.key)).toBeNull();
}

/** No session lives in one tab's memory only: tab A, storage, and tab B agree. */
async function agree(tabs: Tabs) {
  const stored = memory.getItem(tabs.key);
  expect(Boolean(tabs.a.getState().sessions[123])).toBe(stored !== null);
  // B answers Reload after A's Keep mine, and then reads the same sessions.
  await useDraftStore.getState().reloadFromStorage((_stored, _mine, theirs) => theirs);
  expect(Boolean(tabs.b.getState().sessions[123])).toBe(stored !== null);
  return stored;
}

describe('Keep mine after another tab deleted an imported conflict session', () => {
  it('honours the deletion of an untouched session; the kept draft keeps its markers', async () => {
    const tabs = await twoTabs();
    await bResolves(tabs);
    expect(tabs.aDrafts.getState().external).toBe(true);
    await tabs.aDrafts.getState().keepMine();
    expect(await agree(tabs)).toBeNull();
    expect(tabs.disk()[123]?.next).toEqual(tabs.aDrafts.getState().drafts[123]?.next);
    // The text conflict stays visible through its marker blocks; only the row question left.
    expect(tabs.a.getState().open()[0]).toMatchObject({ hash: 123, rows: 0 });
    expect(tabs.a.getState().open()[0]!.markers).toBeGreaterThan(0);
  });

  it('honours the deletion after this tab had answered and published a row', async () => {
    const tabs = await twoTabs();
    tabs.a.getState().choose(123, 'custom', 'mine');
    await tabs.aDrafts.getState().flush();
    expect(JSON.parse(memory.getItem(tabs.key)!).rows.custom).toBe('mine');
    await bResolves(tabs);
    await tabs.aDrafts.getState().keepMine();
    expect(await agree(tabs)).toBeNull();
    expect(tabs.aDrafts.getState().drafts[123]?.next.custom?.name).toBe('Mine');
  });

  it('re-publishes a choice whose draft write was still pending when Keep mine overwrote', async () => {
    const tabs = await twoTabs();
    const release = tabs.gate();
    tabs.a.getState().choose(123, 'custom', 'theirs');
    expect(JSON.parse(memory.getItem(tabs.key)!).rows.custom).toBeNull();
    await bResolves(tabs);
    const keeping = tabs.aDrafts.getState().keepMine();
    release();
    await keeping;
    await tabs.aDrafts.getState().flush();
    const stored = await agree(tabs);
    expect(JSON.parse(stored!).rows.custom).toBe('theirs');
    expect(tabs.b.getState().sessions[123]?.rows.custom).toBe('theirs');
    expect(tabs.disk()[123]?.next.custom?.name).toBe('Theirs');
  });

  it('honours a deletion made while this tab was signed out', async () => {
    const tabs = await twoTabs();
    await tabs.aDrafts.getState().activate(null);
    await bResolves(tabs);
    await tabs.aDrafts.getState().activate(tabs.account);
    expect(await agree(tabs)).toBeNull();
  });
});
