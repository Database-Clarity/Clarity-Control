import { beforeEach, expect, it } from 'vitest';
import { snapshotCompendium, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { createDraftStore } from '../../stores/drafts';
import { confirmCompendiumSelection } from './selection';
import { emptyProgress, readProgress, reviewStorageKey, sourceFingerprint } from './reviewProgress';
import { applyReviewProgress, mayDraftLink, reviewEvidence, reviewQueue } from './reviewQueue';
import { categorySuggestions, suggestionAnchor } from './suggestions';

const cell = { plain: 'Description', runs: [{ text: 'Description', bold: true as const }] };
const row = {
  rowIndex: 10,
  name: 'Test',
  nameNorm: 'test',
  section: 'Intrinsic Traits',
  anchor: { row: 10, col: 0 },
  cell,
};
const tab = {
  gid: '1662574278',
  name: 'Weapon Perks',
  rows: [row],
  grid: [
    { row: 10, col: 0, cell: { plain: 'Test', runs: [{ text: 'Test' }] } },
    { row: 10, col: 2, cell },
  ],
};
const source: CompendiumData = { fetchedAt: '2026-10-31T00:00:00Z', tabs: [tab] };
const fingerprint = sourceFingerprint(source.tabs);
const item = (hash: number) => ({
  hash,
  name: `Test ${hash}`,
  categoryId: 'weapon-frame',
  icon: '',
  inGameDescription: '',
});
function fixture(): EditorData {
  return {
    categories: [],
    items: { 100: item(100), 101: item(101), 102: item(102) },
    aliases: { 101: { to: 100, kind: 'frame' } },
    bundle: {
      sourceCommit: 'abc',
      generatedAt: source.fetchedAt,
      permissions: { users: {} },
      pushed: {},
      tooltips: {
        100: {
          hash: 100,
          text: { en: { text: 'English', updatedBy: 'alice', updatedAt: source.fetchedAt } },
          associated: [200],
        },
        103: {
          hash: 103,
          text: {},
          associated: [],
          compendium: {
            ...snapshotCompendium({ tab, row }),
            rowKey: 'Gone',
            snapshot: { plain: 'zzz', runs: [{ text: 'zzz' }] },
          },
        },
        104: { hash: 104, text: {}, associated: [], compendium: snapshotCompendium({ tab, row }) },
        105: {
          hash: 105,
          text: {},
          associated: [],
          compendium: { ...snapshotCompendium({ tab, row }), rowKey: 'Other' },
        },
      },
    },
  };
}
let editor: EditorData;
beforeEach(() => {
  editor = fixture();
});
it('includes canonical unlinked, missing and candidate repairs, but excludes aliases and healthy links', () => {
  const queue = reviewQueue(editor, source, {}, emptyProgress(), fingerprint);
  expect(queue.map((entry) => entry.hash).sort()).toEqual([100, 102, 103, 105]);
  expect(queue.find((entry) => entry.hash === 103)?.reason).toBe('Needs repair');
});
it('round-trips selected relative cells through normal drafts, preserving other edits; discard reopens, save is authoritative', async () => {
  const store = createDraftStore({ read: async () => ({}), write: async () => {} });
  await store.getState().hydrate();
  const base = editor.bundle.tooltips[100];
  store.getState().edit(base, 'en', 'Edited English', 'alice');
  store.getState().updateDraft(base, (next) => ({ ...next, associated: [200, 201] }));
  const link = confirmCompendiumSelection({ tab, row, cells: [{ dRow: 0, dCol: 2 }] }, source)!;
  expect(link.cells).toEqual([{ dRow: 0, dCol: 2 }]);
  store.getState().updateDraft(base, (next) => ({ ...next, compendium: link }));
  let queue = reviewQueue(editor, source, store.getState().drafts, emptyProgress(), fingerprint);
  expect(queue.find((entry) => entry.hash === 100)).toMatchObject({
    status: 'drafted',
    next: {
      text: { en: { text: 'Edited English' } },
      associated: [200, 201],
    },
  });
  const progress = emptyProgress();
  progress.decisions[100] = {
    kind: 'open',
    fingerprint: queue.find((entry) => entry.hash === 100)!.evidence,
  };
  store.getState().discard(100);
  expect(
    reviewQueue(editor, source, store.getState().drafts, progress, fingerprint).find(
      (entry) => entry.hash === 100,
    )?.status,
  ).toBe('open');
  editor.bundle.tooltips[100] = { ...base, compendium: link };
  queue = reviewQueue(editor, source, {}, progress, fingerprint);
  expect(queue.find((entry) => entry.hash === 100)?.status).toBe('saved');
});
it('persists filters, position, skip/no-equivalent and reopen; source changes reveal tentative negatives', () => {
  for (const kind of ['skipped', 'no-equivalent', 'open'] as const) {
    editor = fixture();
    const progress = emptyProgress();
    const entry = reviewQueue(editor, source, {}, progress, fingerprint).find(
      (entry) => entry.hash === 100,
    )!;
    progress.decisions[entry.hash] = { kind, fingerprint: entry.evidence };
    Object.assign(progress, {
      query: 'Test',
      category: 'weapon-frame',
      selected: entry.hash,
      filter: 'all',
    });
    const loaded = readProgress({ getItem: () => JSON.stringify(progress) }, 'key');
    expect(loaded).toEqual(progress);
    expect(
      reviewQueue(editor, source, {}, loaded, fingerprint).find((entry) => entry.hash === 100)!
        .status,
    ).toBe(kind);
    expect(
      reviewQueue(editor, source, {}, loaded, 'new-source').find((entry) => entry.hash === 100)!,
    ).toMatchObject({
      status: 'open',
      stale: true,
    });
    editor.bundle.tooltips[100].text.en!.text = 'New English evidence';
    expect(
      reviewQueue(editor, source, {}, loaded, fingerprint).find((entry) => entry.hash === 100)!
        .status,
    ).toBe('open');
  }
});
it('isolates identity/data scopes and rejects corrupt/unavailable storage defensively', () => {
  expect(reviewStorageKey('data', 'alice')).not.toBe(reviewStorageKey('data', 'bob'));
  expect(reviewStorageKey('data')).not.toBe(reviewStorageKey('data', 'anonymous'));
  expect(reviewStorageKey('data', 1)).not.toBe(reviewStorageKey('other', 1));
  expect(readProgress({ getItem: () => null }, 'key')).toEqual(emptyProgress());
  for (const raw of ['oops', '{"version":2}', '{"version":1}']) {
    expect(() => readProgress({ getItem: () => raw }, 'key')).toThrow();
  }
  expect(() =>
    readProgress(
      {
        getItem: () => {
          throw new Error('denied');
        },
      },
      'key',
    ),
  ).toThrow('denied');
});
it('gates every link mutation to recovered, unlocked editor/trial/maintainer sessions with an API', () => {
  for (const role of [null, undefined, 'translator', 'unknown'])
    expect(mayDraftLink(role, true, true, false)).toBe(false);
  for (const role of ['editor', 'trial', 'maintainer']) {
    expect(mayDraftLink(role, true, true, false)).toBe(true);
    expect(mayDraftLink(role, false, true, false)).toBe(false);
    expect(mayDraftLink(role, true, false, false)).toBe(false);
    expect(mayDraftLink(role, true, true, true)).toBe(false);
  }
});
it('suggests only configured tabs and actual sections, with rationale rather than confidence', () => {
  expect(categorySuggestions(source, 'weapon-frame', 'Absent')).toEqual([
    expect.objectContaining({
      gid: tab.gid,
      section: 'Intrinsic Traits',
      rationale: expect.stringContaining('not a confirmed match'),
    }),
  ]);
  expect(categorySuggestions(source, 'weapon-trait', 'Absent')[0].section).toBeUndefined();
  expect(categorySuggestions(source, 'unknown', 'Absent')).toEqual([]);
});

it('research suggestions navigate to parsed or arbitrary grid anchors without confirming links', () => {
  expect(
    suggestionAnchor(tab, { gid: tab.gid, section: row.section, rationale: 'configuration' }),
  ).toEqual(row);
  expect(
    suggestionAnchor(tab, { gid: tab.gid, anchor: { row: 10, col: 2 }, rationale: 'observed' }),
  ).toMatchObject({
    name: 'Description',
    anchor: { row: 10, col: 2 },
  });
  expect(
    suggestionAnchor(tab, { gid: tab.gid, anchor: { row: 999, col: 2 }, rationale: 'stale' }),
  ).toBeUndefined();
});

it('reuses resolved evidence for local navigation and decisions; changed source rebuilds repair status', () => {
  const evidence = reviewEvidence(editor, source, {}, fingerprint);
  const progress = emptyProgress();
  const healthy = evidence.find((entry) => entry.hash === 104)!;
  const unlinked = evidence.find((entry) => entry.hash === 100)!;
  const decision = { kind: 'skipped' as const, fingerprint: unlinked.evidence };
  progress.decisions[100] = decision;
  progress.decisions[104] = { kind: 'open', fingerprint: healthy.evidence };
  // Repeated navigation/filter changes reuse the same evidence and preserve decisions.
  for (const selected of [100, 104, 103]) {
    const entries = applyReviewProgress(evidence, {
      ...progress,
      selected,
      query: 'Test',
      filter: 'all',
    });
    expect(entries.find((entry) => entry.hash === 100)?.status).toBe('skipped');
    expect(entries.find((entry) => entry.hash === 104)?.status).toBe('saved');
  }
  const changedSource = { ...source, tabs: [] };
  const refreshed = reviewEvidence(
    editor,
    changedSource,
    {},
    sourceFingerprint(changedSource.tabs),
  );
  const entries = applyReviewProgress(refreshed, progress);
  expect(entries.find((entry) => entry.hash === 100)).toMatchObject({
    status: 'open',
    stale: true,
  });
  expect(entries.find((entry) => entry.hash === 104)).toMatchObject({
    status: 'open',
    reason: 'Needs repair',
  });
  expect(progress.decisions[100]).toBe(decision);
});
