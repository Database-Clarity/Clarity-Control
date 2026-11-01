import { expect, it } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { emptyProgress } from './reviewProgress';
import { reviewQueue } from './reviewQueue';
import type { ReviewProposal } from './rapidReview';
import { categoryId, reviewCategories } from './reviewCategories';

const source: CompendiumData = { fetchedAt: '2026-11-01T00:00:00Z', tabs: [] };
const item = (hash: number, categoryId: string, description = 'Manifest description') => ({
  hash,
  name: `Entry ${hash}`,
  categoryId,
  inGameDescription: description,
  icon: '',
});
function fixture(): EditorData {
  return {
    items: {
      10: item(10, 'weapon-trait'),
      11: item(11, 'weapon-frame', ''),
      12: item(12, 'weapon-frame-enhanced', ''),
      13: item(13, 'weapon-trait-enhanced'),
      14: item(14, 'future-category'),
      15: item(15, 'weapon-trait', ''),
      16: item(16, 'weapon-trait'),
    },
    aliases: { 12: { to: 11, kind: 'frame' }, 16: { to: 15, kind: 'sandbox' } },
    categories: [
      { id: 'weapon-trait', label: 'Weapon traits', group: 'Weapons', order: 1 },
      { id: 'weapon-frame', label: 'Weapon frames', group: 'Weapons', order: 2 },
      { id: 'weapon-trait-enhanced', label: 'Enhanced traits', group: 'Weapons', order: 3 },
    ],
    bundle: {
      sourceCommit: 'test',
      generatedAt: source.fetchedAt,
      permissions: { users: {} },
      pushed: {},
      tooltips: {
        10: { hash: 10, text: {}, associated: [] },
        17: {
          hash: 17,
          text: {},
          associated: [],
          custom: { name: 'Custom', categoryId: 'custom' },
        },
      },
    },
  };
}
it('withholds manifest predicates when generator identity or description differs', () => {
  const editor = fixture();
  editor.items = {
    5699512: {
      hash: 5699512, name: 'Tempered Truss Rod', icon: '',
      categoryId: 'weapon-perk', inGameDescription: '',
    },
  };
  const sample = () => {
    const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
    return reviewCategories(entries, editor, new Map(), false)[0].entries[0];
  };
  const original = sample();
  expect(original.manifestFacts?.item.inventory?.displayName).toBe('Tempered Truss Rod');
  editor.items[5699512].name = 'Changed identity';
  expect(sample().manifestFacts).toBeUndefined();
  editor.items[5699512].name = 'Tempered Truss Rod';
  editor.items[5699512].inGameDescription = 'New behavior from generator';
  expect(sample().manifestFacts).toBeUndefined();
});
it('assigns every queue entry exactly once, including enhanced/custom/unknown categories but not aliases', () => {
  const editor = fixture();
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  const categories = reviewCategories(entries, editor, new Map(), false);
  const hashes = categories.flatMap((category) => category.entries.map((entry) => entry.hash));
  expect(hashes.sort()).toEqual([10, 11, 13, 14, 15, 17]);
  expect(new Set(hashes).size).toBe(entries.length);
  expect(categories.flatMap((category) => Object.values(category.reasons).flat()).length).toBe(
    entries.length,
  );
  expect(categories.find((category) => category.id === categoryId('weapon-trait'))?.rule).toContain(
    '"weapon-trait"',
  );
});
it('keeps ids and deterministic samples stable across input order, matching changes and catalog labels', () => {
  const editor = fixture();
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  const first = reviewCategories(entries, editor, new Map(), false);
  editor.categories.reverse();
  editor.categories[0].label = 'Renamed by generator';
  const second = reviewCategories([...entries].reverse(), editor, new Map(), true);
  expect(first.map((category) => category.id)).toEqual(second.map((category) => category.id));
  expect(first.map((category) => category.samples.map((entry) => entry.hash))).toEqual(
    second.map((category) => category.samples.map((entry) => entry.hash)),
  );
  expect(categoryId('a b')).not.toBe(categoryId('a-b'));
  expect(categoryId('a/b')).not.toBe(categoryId('a%2Fb'));
});
it('uses explicit missing-description/pending/failure reasons rather than silently treating failed matching as no candidate', () => {
  const editor = fixture();
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  for (const [matching, failed, reason] of [
    [true, false, 'pending'],
    [false, true, 'failed'],
    [false, false, 'none'],
  ] as const) {
    const categories = reviewCategories(entries, editor, new Map(), matching, failed);
    const traits = categories.find((category) => category.id === categoryId('weapon-trait'))!;
    expect(traits.reasons[reason].map((entry) => entry.hash)).toEqual([10, 15]);
    expect(
      categories
        .find((category) => category.id === categoryId('weapon-frame'))!
        .reasons['missing-description'].map((entry) => entry.hash),
    ).toEqual([11]);
  }
});
it('samples different matching reasons and caps samples at five without dropping category membership', () => {
  const editor = fixture();
  for (let hash = 20; hash < 40; hash++) editor.items[hash] = item(hash, 'weapon-trait');
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  const match = {
    tab: { gid: '1', name: 'Weapon perks', rows: [] },
    row: {
      rowIndex: 1,
      name: 'Entry',
      nameNorm: 'entry',
      cell: { plain: 'Text', runs: [{ text: 'Text' }] },
    },
  };
  const proposals = new Map<number, ReviewProposal>([
    [20, { candidates: [match] }],
    [
      21,
      {
        candidates: [],
        match,
        link: {
          gid: '1',
          rowKey: 'Entry',
          snapshotAt: source.fetchedAt,
          snapshot: match.row.cell,
        },
      },
    ],
  ]);
  const traits = reviewCategories(entries, editor, proposals, false).find(
    (category) => category.id === categoryId('weapon-trait'),
  )!;
  expect(traits.entries).toHaveLength(22);
  expect(traits.samples).toHaveLength(5);
  expect(traits.samples.map((entry) => entry.hash)).toEqual(expect.arrayContaining([20, 21]));
  expect(traits.reasons.fuzzy.map((entry) => entry.hash)).toEqual([20]);
  expect(traits.reasons.validated.map((entry) => entry.hash)).toEqual([21]);
});
it('covers available subtype and description-pattern variety deterministically, not just alphabetical names', () => {
  const editor = fixture();
  editor.items = Object.fromEntries([
    [20, item(20, 'weapon-trait', 'Simple text')],
    [21, { ...item(21, 'weapon-trait', 'When you reload, gain a bonus.'), owners: [100, 101] }],
    [22, { ...item(22, 'weapon-trait', 'Gain 20% damage.'), baseHash: 200 }],
    [23, item(23, 'weapon-trait', 'First line\nSecond line')],
    [24, item(24, 'weapon-trait', 'A long description. '.repeat(20))],
    [25, item(25, 'weapon-trait', 'Simple text')],
    [26, item(26, 'weapon-trait', 'Simple text')],
  ]);
  editor.aliases = {};
  editor.bundle.tooltips = {};
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  const sampleHashes = (input: typeof entries) =>
    reviewCategories(input, editor, new Map(), false)[0].samples.map((entry) => entry.hash);
  expect(sampleHashes(entries)).toEqual(expect.arrayContaining([21, 22, 23, 24]));
  expect(sampleHashes([...entries].reverse())).toEqual(sampleHashes(entries));
  expect(new Set(sampleHashes(entries)).size).toBe(5);
});
it('fingerprints displayed manifest and alias evidence independently of the authored bundle revision', () => {
  const editor = fixture();
  const entries = reviewQueue(editor, source, {}, emptyProgress(), '');
  const evidence = () =>
    reviewCategories(entries, editor, new Map(), false)
      .flatMap((category) => category.entries)
      .find((entry) => entry.hash === 15)!.sampleEvidence;
  const original = evidence();
  editor.items[16].inGameDescription = 'Changed alias mechanics';
  expect(evidence()).not.toBe(original);
  const changed = evidence();
  editor.items[15].owners = [100, 101];
  expect(evidence()).not.toBe(changed);
  expect(editor.bundle.sourceCommit).toBe('test');
});
