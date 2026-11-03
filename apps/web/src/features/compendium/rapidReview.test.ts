import { describe, expect, it } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { createDraftStore } from '../../stores/drafts';
import {
  advanceHash,
  proposalFor,
  recordDecision,
  restoreLink,
  shortcutAction,
} from './rapidReview';
import { emptyProgress, localDecision } from './reviewProgress';

const source: CompendiumData = {
  fetchedAt: '2026-10-31T00:00:00Z',
  tabs: [
    {
      gid: '1662574278',
      name: 'Weapon Perks',
      rows: [
        {
          rowIndex: 10,
          name: 'Test',
          nameNorm: 'test',
          section: 'Intrinsic Traits',
          cell: { plain: 'Description', runs: [{ text: 'Description', bold: true }] },
        },
      ],
    },
  ],
};
const base: Tooltip = { hash: 100, text: {}, associated: [200] };
const editor: EditorData = {
  categories: [],
  aliases: {},
  items: {
    100: { hash: 100, name: 'Test', categoryId: 'weapon-frame', icon: '', inGameDescription: '' },
  },
  bundle: {
    sourceCommit: 'a',
    generatedAt: source.fetchedAt,
    permissions: { users: {} },
    pushed: {},
    tooltips: { 100: base },
  },
};

describe('rapid review decisions', () => {
  it('advances within the filtered order, handles the last item and empty queue', () => {
    expect(advanceHash([3, 7, 9], 0)).toBe(7);
    expect(advanceHash([3, 7, 9], 2)).toBe(7);
    expect(advanceHash([3], 0)).toBeUndefined();
    expect(advanceHash([], -1)).toBeUndefined();
  });
  it('records local decisions and reopens changed evidence without affecting other decisions', () => {
    const before = recordDecision(emptyProgress(), 2, 'old', 'skipped', 100);
    const next = recordDecision(before, 100, 'evidence', 'no-equivalent', 101);
    expect(next.selected).toBe(101);
    expect(next.decisions[2]).toEqual(before.decisions[2]);
    expect(localDecision(next, 100, 'evidence')).toBe('no-equivalent');
    expect(localDecision(next, 100, 'new')).toBe('open');
    expect(before.decisions[100]).toBeUndefined();
  });
  it('proposes round-trippable resolver links, never fuzzy candidate links', () => {
    expect(proposalFor(base, editor, source).link?.snapshot.plain).toBe('Description');
    const unknown = { ...editor, items: { 100: { ...editor.items[100], name: 'Unrelated' } } };
    expect(
      proposalFor(
        {
          ...base,
          text: { en: { text: 'Description', updatedAt: source.fetchedAt, updatedBy: 'test' } },
        },
        unknown,
        source,
      ).link,
    ).toBeUndefined();
  });
  it('uses reviewed name rules rather than arbitrary research hints', () => {
    expect(proposalFor(base, editor, { ...source, tabs: [] }).link).toBeUndefined();
  });
  it('undoes accepted links through normal drafts while preserving text and associations', async () => {
    const store = createDraftStore({ read: async () => ({}), write: async () => {} });
    await store.getState().hydrate();
    const link = proposalFor(base, editor, source).link!;
    store.getState().updateDraft(base, (next) => ({ ...next, compendium: link }));
    store.getState().edit(base, 'en', 'Later text edit', 'alice');
    store.getState().updateDraft(base, (next) => ({ ...next, associated: [200, 201] }));
    store.getState().updateDraft(base, (next) => restoreLink(next, undefined, link)!);
    expect(store.getState().drafts[100].next.compendium).toBeUndefined();
    expect(store.getState().drafts[100].next.text.en?.text).toBe('Later text edit');
    expect(store.getState().drafts[100].next.associated).toEqual([200, 201]);
  });
  it('refuses undo if link metadata has subsequently changed', () => {
    const link = proposalFor(base, editor, source).link!;
    expect(
      restoreLink({ ...base, compendium: { ...link, rowKey: 'Changed' } }, undefined, link),
    ).toBeUndefined();
  });
  it('removes a link-only draft on undo and preserves an earlier link', async () => {
    const store = createDraftStore({ read: async () => ({}), write: async () => {} });
    await store.getState().hydrate();
    const link = proposalFor(base, editor, source).link!;
    store.getState().updateDraft(base, (next) => ({ ...next, compendium: link }));
    store.getState().updateDraft(base, (next) => restoreLink(next, undefined, link)!);
    expect(store.getState().drafts[100]).toBeUndefined();
    const oldLink = { ...link, rowKey: 'Previous' };
    expect(restoreLink({ ...base, compendium: link }, oldLink, link)?.compendium).toEqual(oldLink);
  });
  it('maps shortcuts and ignores typing, modifiers, and unknown keys', () => {
    const event = { key: 'A', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(shortcutAction(event, false)).toBe('accept');
    expect(shortcutAction({ ...event, key: 'u' }, false)).toBe('undo');
    expect(shortcutAction(event, true)).toBeUndefined();
    expect(shortcutAction({ ...event, ctrlKey: true }, false)).toBeUndefined();
    expect(shortcutAction({ ...event, key: 'x' }, false)).toBeUndefined();
  });
});

it('batches bulk drafts into one persistence operation and rejects invalid batches atomically', async () => {
  const writes: unknown[] = [];
  const store = createDraftStore({
    read: async () => ({}),
    write: async (drafts) => {
      writes.push(drafts);
    },
  });
  await store.getState().hydrate();
  const link = proposalFor(base, editor, source).link!;
  store.getState().updateDrafts(
    [100, 101, 102].map((hash) => ({
      base: { ...base, hash },
      update: (next) => ({ ...next, compendium: link }),
    })),
  );
  await store.getState().flush();
  expect(writes).toHaveLength(1);
  expect(Object.keys(store.getState().drafts)).toHaveLength(3);
  const before = store.getState().drafts;
  expect(() =>
    store.getState().updateDrafts([
      { base, update: (next) => ({ ...next, associated: [] }) },
      { base: { ...base, hash: 101 }, update: (next) => ({ ...next, hash: 999 }) },
    ]),
  ).toThrow('cannot change');
  expect(store.getState().drafts).toBe(before);
  await store.getState().flush();
  expect(writes).toHaveLength(1);
});

it('preselects the suggested rename for manual review without enabling bulk acceptance', () => {
  const linked = {
    ...base,
    compendium: {
      gid: '1',
      rowKey: 'Gone',
      snapshotAt: source.fetchedAt,
      snapshot: { plain: 'Description!', runs: [{ text: 'Description!', bold: true as const }] },
    },
  };
  const proposal = proposalFor(linked, editor, source);
  expect(proposal.suggested).toBe(true);
  expect(proposal.candidates[0].row.name).toBe('Test');
  expect(proposal.link).toBeUndefined();
  expect(proposal.match).toBeUndefined();
  expect(linked.compendium.rowKey).toBe('Gone');
});
