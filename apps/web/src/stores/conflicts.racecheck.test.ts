// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Drafts } from '../services/draftStorage';
import { conflictSessionKey, createConflictStore } from './conflicts';
import { createDraftStore, useDraftStore } from './drafts';

const entry = (text: string) => ({ text, updatedAt: '2026-01-01T10:00:00.000Z', updatedBy: 'a' });
const t = (en: string, extra: Partial<Tooltip> = {}): Tooltip => ({
  hash: 123,
  text: { en: entry(en) },
  associated: [],
  ...extra,
});
const base = t('top\nshared\nbottom');
const head = t('top\ntheirs\nbottom', { associated: [7] });
const mine = t('top\nmine\nbottom');
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
  vi.restoreAllMocks();
});

describe('cross-tab conflict session race regressions', () => {
  it.each(['pending', 'failed', 'signed-out', 'pending-failed'] as const)(
    'retains unpublished choices and their drafts across an account switch (%s)',
    async (mode) => {
      const buckets = new Map<string, Drafts>();
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let fail = mode === 'failed' || mode === 'pending-failed';
      const bucket = (id: string): import('../services/draftStorage').DraftStorage => ({
        read: async () => structuredClone(buckets.get(id) ?? {}),
        write: async (drafts) => {
          if (mode !== 'failed') await waiting;
          if (fail) throw new Error('Quota');
          buckets.set(id, structuredClone(drafts));
        },
      });
      const drafts = createDraftStore({ ...bucket('signed-out'), forUser: bucket });
      await drafts.getState().activate('A');
      const conflicts = conflictsFor(drafts);
      conflicts
        .getState()
        .begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
      if (mode === 'failed') await drafts.getState().flush();
      const switching = drafts.getState().activate(mode === 'signed-out' ? null : 'B');
      finish();
      await switching;
      expect(conflicts.getState().sessions).toEqual({});
      expect(memory.getItem(conflictSessionKey('B', 123))).toBeNull();
      expect(memory.getItem(conflictSessionKey('signed-out', 123))).toBeNull();
      if (mode === 'failed' || mode === 'pending-failed')
        expect(drafts.getState().previousAccountError).toContain('Quota');
      else expect(memory.getItem(conflictSessionKey('A', 123))).not.toBeNull();
      await drafts.getState().activate('A');
      expect(drafts.getState().drafts[123]?.next).toEqual(mine);
      expect(conflicts.getState().sessions[123]?.rows.$exists).toBeNull();
      fail = false;
      drafts.getState().retry();
      await drafts.getState().flush();
      expect(memory.getItem(conflictSessionKey('A', 123))).not.toBeNull();
    },
  );

  it('Keep mine reconciles an imported session deleted elsewhere on its next storage read', async () => {
    let time = 10;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    memory.setItem(
      conflictSessionKey('1', 123),
      JSON.stringify({
        hash: 123,
        base: null,
        head,
        mine,
        rows: { $exists: null },
        storedAt: 20,
      }),
    );
    const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
    await drafts.getState().activate('1');
    const conflicts = conflictsFor(drafts);
    expect(conflicts.getState().sessions[123]).toBeDefined();
    memory.removeItem(conflictSessionKey('1', 123));
    time = 30;
    await drafts.getState().keepMine();
    expect(conflicts.getState().sessions).toEqual({});
    conflicts.getState().choose(123, '$exists', 'mine');
    expect(drafts.getState().drafts).toEqual({});
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
  });

  it('binds pending publication to A through an A to B to A switch', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const disk = new Map<string, Drafts>();
    const bucket = (id: string): import('../services/draftStorage').DraftStorage => ({
      read: async () => structuredClone(disk.get(id) ?? {}),
      write: async (drafts) => {
        await waiting;
        disk.set(id, structuredClone(drafts));
      },
    });
    const drafts = createDraftStore({ ...bucket('signed-out'), forUser: bucket });
    await drafts.getState().activate('A');
    const conflicts = conflictsFor(drafts);
    conflicts.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    const toB = drafts.getState().activate('B');
    const toA = drafts.getState().activate('A');
    finish();
    await Promise.all([toB, toA]);
    expect(conflicts.getState().sessions[123]?.rows.$exists).toBeNull();
    expect(drafts.getState().drafts[123]?.next).toEqual(mine);
    expect(memory.getItem(conflictSessionKey('B', 123))).toBeNull();
  });

  it('a stale tab cannot answer and resurrect a session another tab resolved', async () => {
    memory.setItem(
      conflictSessionKey('1', 123),
      JSON.stringify({
        hash: 123,
        base: null,
        head,
        mine,
        rows: { $exists: null },
        storedAt: 20,
      }),
    );
    const drafts = createDraftStore({
      read: async () => ({ 123: { base, next: mine } }),
      write: async () => {},
    });
    await drafts.getState().activate('1');
    const conflicts = conflictsFor(drafts);
    memory.removeItem(conflictSessionKey('1', 123));
    conflicts.getState().choose(123, '$exists', 'theirs');
    expect(drafts.getState().drafts[123]?.next).toEqual(mine);
    expect(conflicts.getState().sessions).toEqual({});
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
  });

  it('retains a session when localStorage quota fails across an account switch', async () => {
    const disk = new Map<string, Drafts>();
    const bucket = (id: string): import('../services/draftStorage').DraftStorage => ({
      read: async () => structuredClone(disk.get(id) ?? {}),
      write: async (drafts) => {
        disk.set(id, structuredClone(drafts));
      },
    });
    const drafts = createDraftStore({ ...bucket('signed-out'), forUser: bucket });
    await drafts.getState().activate('A');
    const conflicts = conflictsFor(drafts);
    const fail = vi.spyOn(memory, 'setItem').mockImplementation(() => {
      throw new Error('Quota');
    });
    conflicts.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    await drafts.getState().flush();
    await drafts.getState().activate('B');
    expect(drafts.getState().previousAccountError).toBeTruthy();
    fail.mockRestore();
    await drafts.getState().activate('A');
    expect(conflicts.getState().sessions[123]?.rows.$exists).toBeNull();
    expect(drafts.getState().drafts[123]?.next).toEqual(mine);
    expect(memory.getItem(conflictSessionKey('A', 123))).not.toBeNull();
  });

  it('keeps two tabs on different accounts isolated for the same hash', async () => {
    const aDrafts = createDraftStore({ read: async () => ({}), write: async () => {} });
    const bDrafts = createDraftStore({ read: async () => ({}), write: async () => {} });
    await Promise.all([aDrafts.getState().activate('A'), bDrafts.getState().activate('B')]);
    const a = conflictsFor(aDrafts);
    const b = conflictsFor(bDrafts);
    a.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    b.getState().begin([{ hash: 123, base: null, head, next: t('B mine'), fields: ['$exists'] }]);
    await Promise.all([aDrafts.getState().flush(), bDrafts.getState().flush()]);
    a.getState().choose(123, '$exists', 'theirs');
    b.getState().refresh();
    expect(b.getState().sessions[123]?.rows.$exists).toBeNull();
    expect(bDrafts.getState().drafts[123]?.next.text.en?.text).toBe('B mine');
    expect(memory.getItem(conflictSessionKey('A', 123))).toBeNull();
    expect(memory.getItem(conflictSessionKey('B', 123))).not.toBeNull();
  });

  it('a tab starting while the other tab draft write is in flight keeps its session', () => {
    // Reviewer probe: this tab's settled flags say nothing about the writer's draft.
    useDraftStore.setState({
      hydrated: true,
      owner: '1',
      drafts: { 123: { base, next: mine } },
      pending: 0,
      external: false,
      error: null,
      retry: () => undefined,
      flush: async () => undefined,
    });
    const b = conflictsFor(useDraftStore);
    b.getState().begin([{ hash: 123, base, head, next: mine, fields: ['text.en', 'custom'] }]);
    expect(b.getState().sessions[123]?.rows.custom).toBeNull();
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
    const aDrafts = createDraftStore({ read: async () => ({}), write: async () => {} });
    aDrafts.setState({ hydrated: true, owner: '1', drafts: {} });
    conflictsFor(aDrafts);
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
  });

  it('publishes after the draft write, and keeps it against reads begun before publication', async () => {
    let time = 10;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    let disk: Drafts = {};
    let finishWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const bDrafts = createDraftStore({
      read: async () => structuredClone(disk),
      write: async (drafts) => {
        await writing;
        disk = structuredClone(drafts);
      },
    });
    await bDrafts.getState().activate('1');
    const b = conflictsFor(bDrafts);
    b.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    expect(bDrafts.getState().pending).toBeGreaterThan(0);
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    time = 20;
    const aDrafts = createDraftStore({
      read: async () => structuredClone(disk),
      write: async () => {},
    });
    await aDrafts.getState().activate('1');
    const a = conflictsFor(aDrafts);
    await aDrafts.getState().reloadFromStorage((_ancestor, _mine, theirs) => theirs);
    expect(aDrafts.getState().drafts).toEqual({});
    time = 30;
    finishWrite();
    await bDrafts.getState().flush();
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
    a.getState().refresh();
    expect(a.getState().sessions[123]?.rows.$exists).toBeNull();
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
    time = 40;
    await aDrafts.getState().reloadFromStorage((_ancestor, _mine, theirs) => theirs);
    a.getState().refresh();
    expect(a.getState().open()).toMatchObject([{ hash: 123, rows: 1 }]);
  });

  it('refresh removes imported sessions resolved elsewhere and choose cannot recreate them', async () => {
    const bDrafts = createDraftStore({ read: async () => ({}), write: async () => {} });
    await bDrafts.getState().activate('1');
    const b = conflictsFor(bDrafts);
    b.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    await bDrafts.getState().flush();
    const aDrafts = createDraftStore({
      read: async () => bDrafts.getState().drafts,
      write: async () => {},
    });
    await aDrafts.getState().activate('1');
    const a = conflictsFor(aDrafts);
    expect(a.getState().sessions[123]).toBeDefined();
    b.getState().choose(123, '$exists', 'theirs');
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    a.getState().refresh();
    expect(a.getState().sessions).toEqual({});
    a.getState().choose(123, '$exists', 'mine');
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
  });

  it.each([false, true])(
    'prunes a draft-less orphan after a fresh startup read (legacy: %s)',
    async (legacy) => {
      vi.spyOn(Date, 'now').mockReturnValue(20);
      memory.setItem(
        conflictSessionKey('1', 123),
        JSON.stringify({
          hash: 123,
          base,
          head,
          mine,
          rows: { custom: null },
          ...(legacy ? {} : { storedAt: 10 }),
        }),
      );
      const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
      await drafts.getState().activate('1');
      const conflicts = conflictsFor(drafts);
      expect(conflicts.getState().open()).toEqual([]);
      expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    },
  );

  it('does not treat completion of an older Reload as a local discard', async () => {
    let time = 10;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    let finishRead!: (drafts: Drafts) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let reload = false;
    const drafts = createDraftStore({
      read: async () => {
        if (!reload) return { 123: { base, next: mine } };
        started();
        return new Promise<Drafts>((resolve) => {
          finishRead = resolve;
        });
      },
      write: async () => {},
    });
    await drafts.getState().activate('1');
    const conflicts = conflictsFor(drafts);
    reload = true;
    const reloading = drafts.getState().reloadFromStorage((_ancestor, _mine, theirs) => theirs);
    await reading;
    time = 20;
    memory.setItem(
      conflictSessionKey('1', 123),
      JSON.stringify({
        hash: 123,
        base: null,
        head,
        mine,
        rows: { $exists: null },
        storedAt: time,
      }),
    );
    conflicts.getState().refresh();
    time = 30;
    finishRead({});
    await reloading;
    expect(conflicts.getState().sessions[123]).toBeDefined();
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
  });

  it('keeps a failed draft write local through refresh, then publishes after retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('Quota')).mockResolvedValue(undefined);
    const drafts = createDraftStore({ read: async () => ({}), write });
    await drafts.getState().activate('1');
    const conflicts = conflictsFor(drafts);
    conflicts.getState().begin([{ hash: 123, base: null, head, next: mine, fields: ['$exists'] }]);
    await drafts.getState().flush();
    expect(drafts.getState().error).toContain('Quota');
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    conflicts.getState().refresh();
    expect(conflicts.getState().sessions[123]?.rows.$exists).toBeNull();
    drafts.getState().retry();
    await drafts.getState().flush();
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
  });
});
