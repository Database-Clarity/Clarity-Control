// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findConflictBlocks, type Tooltip } from '@clarity/core';
import type { SaveConflict } from '../services/api';
import type { Drafts } from '../services/draftStorage';
import { editorData } from '../services/save/fixtures.testSupport';
import { clearSavedOverlay } from './savedOverlay';
import {
  applyHeadToData,
  conflictsKey,
  conflictSessionKey,
  createConflictStore,
} from './conflicts';
import { useDataStore } from './data';
import { createDraftStore, useDraftStore } from './drafts';

const entry = (text: string, by = 'author') => ({
  text,
  updatedAt: '2026-01-01T10:00:00.000Z',
  updatedBy: by,
});
const tooltip = (en: string, extra: Partial<Tooltip> = {}): Tooltip => ({
  hash: 123,
  text: { en: entry(en) },
  associated: [],
  ...extra,
});
const base = tooltip('top\nshared\nbottom');
const head = tooltip('top\ntheirs\nbottom', { associated: [7] });
const mine = tooltip('top\nmine\nbottom');
const textConflict: SaveConflict = { hash: 123, base, head, next: mine, fields: ['text.en'] };

const saved = new Map<string, string>();
const memory = {
  get length() {
    return saved.size;
  },
  key: (index: number) => [...saved.keys()][index] ?? null,
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => void saved.set(key, value),
  removeItem: (key: string) => void saved.delete(key),
};
const make = () =>
  createConflictStore({
    drafts: useDraftStore,
    storage: () => memory,
    applyHead: applyHeadToData,
  });
let useConflictStore = make();
let stop = () => {};

function reset(drafts: Drafts = { 123: { base, next: mine } }) {
  saved.clear();
  clearSavedOverlay();
  stop();
  useConflictStore = make();
  useDataStore.setState({
    data: { ...editorData(), bundle: { ...editorData().bundle, tooltips: { 123: base } } },
  });
  useDraftStore.setState({
    drafts,
    hydrated: true,
    error: null,
    owner: '1',
    generation: 1,
    pending: 0,
    external: false,
    retry: () => undefined,
    flush: async () => undefined,
  });
  useConflictStore.setState({ scope: '1', sessions: {} });
  stop = useConflictStore.getState().start();
}
const draft = () => useDraftStore.getState().drafts[123];
const bundle = () => useDataStore.getState().data!.bundle.tooltips[123];

beforeEach(() => reset());
afterEach(() => {
  stop();
  saved.clear();
});

describe('conflict store', () => {
  it('rebases the draft on the server version and writes the marker block', () => {
    const result = useConflictStore.getState().begin([textConflict]);
    expect(result).toEqual({ markers: 1, tooltips: 1, merged: 0, rows: 0 });
    expect(draft()!.base).toEqual(head);
    expect(draft()!.next.associated).toEqual([7]);
    expect(findConflictBlocks(draft()!.next.text.en!.text)).toHaveLength(1);
    // The editor now shows the server's version as the saved one.
    expect(bundle()).toEqual(head);
    expect(useConflictStore.getState().open()).toEqual([
      { hash: 123, markers: 1, byLanguage: { en: 1 }, rows: 0, total: 1 },
    ]);
  });

  it('ends the session when the last block is resolved, by an edit of any kind', () => {
    useConflictStore.getState().begin([textConflict]);
    expect(useConflictStore.getState().sessions[123]).toBeDefined();
    useDraftStore.getState().edit(head, 'en', 'top\nmine\nbottom', 'alice');
    expect(useConflictStore.getState().sessions[123]).toBeUndefined();
    expect(useConflictStore.getState().open()).toEqual([]);
  });

  it('merges silently when the two sides touched different lines', () => {
    const result = useConflictStore.getState().begin([
      {
        hash: 123,
        base: tooltip('a\nb\nc\nd\ne'),
        head: tooltip('A\nb\nc\nd\ne'),
        next: tooltip('a\nb\nc\nd\nE'),
        fields: ['text.en'],
      },
    ]);
    expect(result).toEqual({ markers: 0, tooltips: 1, merged: 1, rows: 0 });
    expect(draft()!.next.text.en!.text).toBe('A\nb\nc\nd\nE');
    expect(useConflictStore.getState().open()).toEqual([]);
    expect(useConflictStore.getState().sessions).toEqual({});
  });

  it('keeps a non-text conflict as a row until chosen, either way', () => {
    const custom = (name: string) => ({ name, categoryId: 'perk' });
    const conflict: SaveConflict = {
      hash: 123,
      base: tooltip('x', { custom: custom('Base') }),
      head: tooltip('x', { custom: custom('Theirs') }),
      next: tooltip('x', { custom: custom('Mine') }),
      fields: ['custom'],
    };
    useConflictStore.getState().begin([conflict]);
    expect(useConflictStore.getState().open()[0]).toMatchObject({ rows: 1, markers: 0, total: 1 });
    expect(draft()!.next.custom).toEqual(custom('Mine'));
    useConflictStore.getState().choose(123, 'custom', 'theirs');
    expect(draft()!.next.custom).toEqual(custom('Theirs'));
    expect(useConflictStore.getState().open()).toEqual([]);
  });

  it('asks about a tooltip deleted on the server: keep mine brings it back as new', () => {
    const conflict: SaveConflict = { hash: 123, base, head: null, next: mine, fields: ['$exists'] };
    useConflictStore.getState().begin([conflict]);
    expect(useConflictStore.getState().open()[0]).toMatchObject({ rows: 1 });
    useConflictStore.getState().choose(123, '$exists', 'mine');
    expect(draft()!.next).toEqual(mine);
    // Saved as a new tooltip next: the editor no longer has it as saved text.
    expect(bundle()).toBeUndefined();
    expect(useConflictStore.getState().open()).toEqual([]);
  });

  it('accepting a server deletion discards the draft and the saved text', () => {
    const conflict: SaveConflict = { hash: 123, base, head: null, next: mine, fields: ['$exists'] };
    useConflictStore.getState().begin([conflict]);
    useConflictStore.getState().choose(123, '$exists', 'theirs');
    expect(draft()).toBeUndefined();
    expect(bundle()).toBeUndefined();
    expect(useConflictStore.getState().sessions).toEqual({});
  });

  it('handles a tooltip created on the server meanwhile', () => {
    const conflict: SaveConflict = { hash: 123, base: null, head, next: mine, fields: ['$exists'] };
    useConflictStore.getState().begin([conflict]);
    expect(bundle()).toEqual(head);
    useConflictStore.getState().choose(123, '$exists', 'mine');
    expect(draft()!.base).toEqual(head);
    expect(draft()!.next).toEqual(mine);
    reset();
    useConflictStore.getState().begin([conflict]);
    useConflictStore.getState().choose(123, '$exists', 'theirs');
    expect(draft()).toBeUndefined();
    expect(bundle()).toEqual(head);
  });

  it('keeps a new tooltip from a one-shot review with no server base', () => {
    reset({});
    const next = { ...tooltip('new'), hash: 456 };
    useConflictStore.getState().begin([textConflict], [{ hash: 456, base: null, next }]);
    expect(useDraftStore.getState().drafts[456]?.next).toEqual(next);
  });

  it('keeps the changes of a one-shot review that did not conflict as drafts', () => {
    reset({});
    const other = { ...tooltip('other'), hash: 456 };
    useConflictStore
      .getState()
      .begin([textConflict], [{ hash: 456, base: { ...tooltip('o'), hash: 456 }, next: other }]);
    expect(useDraftStore.getState().drafts[456]!.next).toEqual(other);
    // A draft already there is never replaced by the review's copy.
    useDraftStore.getState().edit({ ...tooltip('o'), hash: 456 }, 'en', 'newer', 'alice');
    useConflictStore.getState().begin([], [{ hash: 456, base: tooltip('o'), next: other }]);
    expect(useDraftStore.getState().drafts[456]!.next.text.en!.text).toBe('newer');
  });
});

describe('conflict store persistence', () => {
  it('saves the session per account and restores it with the drafts', () => {
    useConflictStore.getState().begin([
      {
        hash: 123,
        base: tooltip('x', { custom: { name: 'B', categoryId: 'perk' } }),
        head: tooltip('x', { custom: { name: 'T', categoryId: 'perk' } }),
        next: tooltip('x', { custom: { name: 'M', categoryId: 'perk' } }),
        fields: ['custom'],
      },
    ]);
    expect(memory.getItem(conflictSessionKey('1', 123))).toContain('"custom":null');
    const again = make();
    const stop = again.getState().start();
    expect(again.getState().open()[0]).toMatchObject({ hash: 123, rows: 1 });
    stop();
  });

  it('migrates the existing account snapshot without replacing newer sessions', () => {
    useConflictStore.getState().begin([textConflict]);
    const session = useConflictStore.getState().sessions[123]!;
    const other = { ...session, hash: 456, mine: { ...mine, hash: 456 }, rows: { $exists: null } };
    memory.setItem(
      conflictsKey('1'),
      JSON.stringify({ 123: { ...session, rows: { custom: null } }, 456: other }),
    );
    useDraftStore.setState(({ drafts }) => ({
      drafts: { ...drafts, 456: { base: other.head!, next: other.mine } },
    }));
    const again = make();
    const stop = again.getState().start();
    expect(again.getState().sessions[123]).toEqual(session);
    expect(again.getState().sessions[456]).toEqual(other);
    expect(memory.getItem(conflictsKey('1'))).toBeNull();
    expect(memory.getItem(conflictSessionKey('1', 456))).not.toBeNull();
    stop();
  });

  it('reads other sessions despite a damaged legacy snapshot or session', () => {
    useConflictStore.getState().begin([textConflict]);
    memory.setItem(conflictsKey('1'), '{not json');
    memory.setItem(conflictSessionKey('1', 456), '{not json');
    const again = make();
    const stop = again.getState().start();
    expect(again.getState().sessions[123]).toBeDefined();
    stop();
  });

  it('drops a session whose draft is gone, and ignores an unreadable copy', () => {
    useConflictStore.getState().begin([textConflict]);
    useDraftStore.getState().discard(123);
    expect(useConflictStore.getState().sessions).toEqual({});
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    memory.setItem(conflictsKey('1'), '{not json');
    const again = make();
    const stop = again.getState().start();
    expect(again.getState().sessions).toEqual({});
    stop();
  });

  it('follows the account: another account starts with none', () => {
    useConflictStore.getState().begin([textConflict]);
    const again = make();
    const stop = again.getState().start();
    expect(again.getState().sessions[123]).toBeDefined();
    useDraftStore.setState({ owner: '2', generation: 2, drafts: {} });
    expect(again.getState().scope).toBe('2');
    expect(again.getState().sessions).toEqual({});
    // The first account's session is still saved for it.
    expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
    stop();
  });

  it('refresh keeps unresolved local rows when storing the session failed', () => {
    const fail = vi.spyOn(memory, 'setItem').mockImplementation(() => {
      throw new Error('Storage full');
    });
    try {
      useConflictStore.getState().begin([{ ...textConflict, fields: ['text.en', 'custom'] }]);
      expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
      useConflictStore.getState().refresh();
      expect(useConflictStore.getState().sessions[123]?.rows.custom).toBeNull();
      expect(useConflictStore.getState().open()[0]).toMatchObject({ rows: 1, markers: 1 });
    } finally {
      fail.mockRestore();
    }
  });

  it.each(['pending', 'external'] as const)(
    'keeps imported sessions while drafts are %s, then prunes when settled',
    (waiting) => {
      useConflictStore.getState().begin([{ ...textConflict, fields: ['text.en', 'custom'] }]);
      stop();
      useDraftStore.setState({
        drafts: {},
        pending: waiting === 'pending' ? 1 : 0,
        external: waiting === 'external',
      });
      const again = make();
      const stopAgain = again.getState().start();
      try {
        expect(again.getState().sessions[123]).toBeDefined();
        expect(memory.getItem(conflictSessionKey('1', 123))).not.toBeNull();
        useDraftStore.setState({ pending: 0, external: false });
        expect(again.getState().sessions).toEqual({});
        expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
      } finally {
        stopAgain();
      }
    },
  );

  it('refresh merges the other tab choices without losing mine', () => {
    const custom = (name: string) => ({ name, categoryId: 'perk' });
    useConflictStore.getState().begin([
      {
        hash: 123,
        base: tooltip('top\nshared\nbottom', { custom: custom('B') }),
        head: tooltip('top\ntheirs\nbottom', { custom: custom('T') }),
        next: tooltip('top\nmine\nbottom', { custom: custom('M') }),
        fields: ['text.en', 'custom'],
      },
    ]);
    const stored = JSON.parse(memory.getItem(conflictSessionKey('1', 123))!);
    stored.rows.custom = 'theirs';
    memory.setItem(conflictSessionKey('1', 123), JSON.stringify(stored));
    useConflictStore.getState().refresh();
    // The text block keeps the session alive; the other tab's answer for the row is adopted.
    expect(useConflictStore.getState().sessions[123]!.rows.custom).toBe('theirs');
    // An answer given here is never overwritten by the other tab's open row.
    useConflictStore.getState().choose(123, 'custom', 'mine');
    stored.rows.custom = null;
    memory.setItem(conflictSessionKey('1', 123), JSON.stringify(stored));
    useConflictStore.getState().refresh();
    expect(useConflictStore.getState().sessions[123]!.rows.custom).toBe('mine');
  });
});

describe('independent tabs', () => {
  it('keeps both tabs rows when stale tabs begin and resolve conflicts', () => {
    const tab = (loaded: Drafts = {}) => {
      const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
      drafts.setState({ hydrated: true, owner: '1', drafts: loaded });
      const conflicts = createConflictStore({ drafts, storage: () => memory, applyHead: () => {} });
      const stop = conflicts.getState().start();
      return { drafts, conflicts, stop };
    };
    const a = tab();
    const b = tab();
    const row = (hash: number): SaveConflict => ({
      hash,
      base: null,
      head: { ...head, hash },
      next: { ...mine, hash },
      fields: ['$exists'],
    });
    try {
      a.conflicts.getState().begin([row(123)]);
      b.conflicts.getState().begin([row(456)]);
      // The other tab's draft write has not been reloaded here yet.
      a.drafts.setState({ external: true });
      a.conflicts.getState().refresh();
      expect(
        a.conflicts
          .getState()
          .open()
          .map(({ hash }) => hash),
      ).toEqual([123, 456]);
      a.conflicts.getState().choose(123, '$exists', 'theirs');
      const reloaded = tab(b.drafts.getState().drafts);
      try {
        expect(
          reloaded.conflicts
            .getState()
            .open()
            .map(({ hash }) => hash),
        ).toEqual([456]);
      } finally {
        reloaded.stop();
      }
      b.conflicts.getState().refresh();
      expect(
        b.conflicts
          .getState()
          .open()
          .map(({ hash }) => hash),
      ).toEqual([456]);
    } finally {
      a.stop();
      b.stop();
    }
  });
});

describe('stale session regressions', () => {
  it('prunes a session whose rebase equals the server version (no draft left)', () => {
    reset({ 123: { base, next: head } });
    useConflictStore.getState().begin([{ hash: 123, base, head, next: head, fields: ['text.en'] }]);
    expect(draft()).toBeUndefined();
    expect(useConflictStore.getState().sessions).toEqual({});
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
  });
  it.each(['pending', 'external'] as const)(
    'prunes an identical rebase even when drafts are %s',
    (waiting) => {
      reset({ 123: { base, next: head } });
      useDraftStore.setState({
        pending: waiting === 'pending' ? 1 : 0,
        external: waiting === 'external',
      });
      useConflictStore
        .getState()
        .begin([{ hash: 123, base, head, next: head, fields: ['text.en'] }]);
      expect(draft()).toBeUndefined();
      expect(useConflictStore.getState().sessions).toEqual({});
      expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
    },
  );
  it('prunes an orphan session at startup when its draft is gone', () => {
    useConflictStore.getState().begin([{ ...textConflict, fields: ['text.en', 'custom'] }]);
    stop();
    useDraftStore.setState({ drafts: {} });
    const again = make();
    const s = again.getState().start();
    const open = again.getState().open();
    s();
    expect(open).toEqual([]);
    expect(memory.getItem(conflictSessionKey('1', 123))).toBeNull();
  });
});
