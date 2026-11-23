import { beforeEach, expect, it } from 'vitest';
import { snapshotCompendium, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { createDraftStore } from '../../stores/drafts';
import { confirmCompendiumSelection } from './selection';
import { emptyProgress, readProgress, reviewStorageKey, sourceFingerprint } from './reviewProgress';
import {
  applyReviewProgress,
  entryEvidence,
  mayDraftLink,
  reviewEvidence,
  reviewQueue,
} from './reviewQueue';
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
  expect(queue.map((entry) => entry.hash).sort()).toEqual([100, 102, 103]);
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
it('keeps archived tooltips out of the unresolved queue', () => {
  editor = fixture();
  editor.bundle.tooltips[100].archive = {
    removedAt: '2026-10-01T00:00:00.000Z',
    lastSeen: { name: 'Gone', categoryId: 'weapon-frame', manifestVersion: 'v1' },
  };
  expect(reviewEvidence(editor, source, {}, fingerprint).map((entry) => entry.hash)).not.toContain(
    100,
  );
});
it('persists filters, position, skip/no-equivalent and reopen; only the entry itself reopens them', () => {
  for (const kind of ['skipped', 'no-equivalent', 'open'] as const) {
    editor = fixture();
    const progress = emptyProgress();
    const entry = reviewQueue(editor, source, {}, progress, fingerprint).find(
      (entry) => entry.hash === 100,
    )!;
    progress.decisions[entry.hash] = { kind, fingerprint: entryEvidence(entry) };
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
    ).toMatchObject({ status: kind, reason: 'Unlinked', stale: false });
    editor.bundle.tooltips[100].text.en!.text = 'New English evidence';
    expect(
      reviewQueue(editor, source, {}, loaded, fingerprint).find((entry) => entry.hash === 100)!
        .status,
    ).toBe('open');
  }
});
it('keeps decisions recorded with an earlier sheet, and never calls an unlinked entry changed', () => {
  // The fingerprint earlier versions recorded: the whole sheet and the entry in one digest.
  const old = reviewEvidence(editor, source, {}, 'earlier sheet').find(
    (entry) => entry.hash === 100,
  )!.evidence;
  for (const kind of ['skipped', 'no-equivalent', 'open'] as const) {
    const progress = emptyProgress();
    progress.decisions[100] = { kind, fingerprint: old };
    const entry = reviewQueue(editor, source, {}, progress, fingerprint).find(
      (entry) => entry.hash === 100,
    )!;
    expect(entry).toMatchObject({ status: kind, reason: 'Unlinked' });
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
  const decision = { kind: 'skipped' as const, fingerprint: entryEvidence(unlinked) };
  progress.decisions[100] = decision;
  progress.decisions[104] = { kind: 'open', fingerprint: entryEvidence(healthy) };
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
    status: 'skipped',
    reason: 'Unlinked',
  });
  expect(entries.find((entry) => entry.hash === 104)).toMatchObject({
    status: 'open',
    reason: 'Needs repair',
  });
  expect(progress.decisions[100]).toBe(decision);
});

it('hides selectors from review worklists without deleting their tooltip records', () => {
  const editor = fixture();
  editor.items[100] = { ...editor.items[100], name: 'Set Bonus: Example', hiddenFromEditor: true };
  const before = JSON.stringify(editor);
  expect(reviewEvidence(editor, source, {}, fingerprint).some((entry) => entry.hash === 100)).toBe(
    false,
  );
  expect(JSON.stringify(editor)).toBe(before);
});

it('hides inactive unlinked, repair, and saved-link rows, then restores their unchanged evidence and links', () => {
  const original = reviewEvidence(editor, source, {}, fingerprint);
  const progress = emptyProgress();
  progress.decisions[104] = {
    kind: 'open',
    fingerprint: original.find((entry) => entry.hash === 104)!.evidence,
  };
  const saved = JSON.stringify(editor.bundle.tooltips);
  const link = editor.bundle.tooltips[104].compendium;
  const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
  editor.bundle.inactiveMoves = { 100: stamp, 103: stamp, 104: stamp };
  expect(reviewEvidence(editor, source, {}, fingerprint).map((entry) => entry.hash)).not.toEqual(
    expect.arrayContaining([100, 103, 104]),
  );
  for (const hash of [100, 103, 104]) {
    expect(
      reviewEvidence(editor, source, {}, fingerprint).some((entry) => entry.hash === hash),
    ).toBe(false);
    expect(
      reviewQueue(editor, source, {}, progress, fingerprint).some((entry) => entry.hash === hash),
    ).toBe(false);
  }
  expect(JSON.stringify(editor.bundle.tooltips)).toBe(saved);
  editor.bundle.inactiveMoves = Object.fromEntries(
    [100, 103, 104].map((hash) => [hash, { ...stamp, inactive: false as const }]),
  );
  const restored = reviewEvidence(editor, source, {}, fingerprint);
  expect(restored).toEqual(original);
  expect(editor.bundle.tooltips[104].compendium).toBe(link);
  const queue = reviewQueue(editor, source, {}, progress, fingerprint);
  expect(queue.find((entry) => entry.hash === 100)?.reason).toBe('Unlinked');
  expect(queue.find((entry) => entry.hash === 103)?.reason).toBe('Needs repair');
  expect(queue.find((entry) => entry.hash === 104)?.status).toBe('saved');
});

it('preserves the shared English-equivalence helper across an inactive round trip', () => {
  editor.bundle.tooltips[100].text.en!.text = '#e4 damage';
  const old = reviewEvidence(editor, source, {}, fingerprint).find((entry) => entry.hash === 100)!;
  const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
  editor.bundle.inactiveMoves = { 100: stamp };
  editor.bundle.tooltips[100].text.en!.text = '<enhanced/>4 damage';
  expect(reviewEvidence(editor, source, {}, fingerprint).some((entry) => entry.hash === 100)).toBe(
    false,
  );
  editor.bundle.inactiveMoves = { 100: { ...stamp, inactive: false } };
  expect(
    reviewEvidence(editor, source, {}, fingerprint).find((entry) => entry.hash === 100)!.evidence,
  ).toBe(old.evidence);
});

it('keeps a similar rename in the repair queue until explicitly confirmed', () => {
  const base = editor.bundle.tooltips[104];
  base.compendium = {
    ...base.compendium!,
    rowKey: 'Gone',
    snapshot: {
      plain: 'Description!',
      runs: [{ text: 'Description!', bold: true }],
    },
  };
  const pending = reviewQueue(editor, source, {}, emptyProgress(), fingerprint);
  expect(pending.find((entry) => entry.hash === 104)).toMatchObject({
    status: 'open',
    reason: 'Needs repair',
  });
  const confirmed = confirmCompendiumSelection({ tab, row }, source)!;
  const drafts = { 104: { base, next: { ...base, compendium: confirmed } } };
  const queue = reviewQueue(editor, source, drafts, emptyProgress(), fingerprint);
  expect(queue.find((entry) => entry.hash === 104)).toMatchObject({ status: 'drafted' });
});

it('keeps duplicate identical rename matches in the candidate repair queue', () => {
  const duplicateSource = {
    ...source,
    tabs: [
      {
        ...tab,
        rows: [
          row,
          {
            ...row,
            name: 'Other identity',
            nameNorm: 'other identity',
            rowIndex: 11,
            anchor: { row: 11, col: 0 },
          },
        ],
      },
    ],
  };
  const queue = reviewQueue(
    editor,
    duplicateSource,
    {},
    emptyProgress(),
    sourceFingerprint(duplicateSource.tabs),
  );
  expect(queue.find((entry) => entry.hash === 105)).toMatchObject({
    status: 'open',
    reason: 'Needs repair',
  });
});
