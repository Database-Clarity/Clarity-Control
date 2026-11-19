import { expect, it } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import { guidanceSchema } from './guidanceSchema';
import { reviewCategories } from './reviewCategories';
import { reviewQueue } from './reviewQueue';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { proposalFor } from './rapidReview';
import { guidedDecisions } from './guidedDecisions';
import {
  currentReferenceLink,
  groupReferenceCurrent,
  referenceCurrent,
  sampleReference,
} from './sampleReferences';
import type { EditorData } from '../../stores/data';

const timestamp = '2026-11-01T00:00:00Z';

function fixture(texts: Record<number, string> = {}) {
  const source: CompendiumData = {
    fetchedAt: timestamp,
    tabs: [
      {
        gid: '1662574278',
        name: 'Weapon Perks',
        rows: Array.from({ length: 6 }, (_, i) => ({
          rowIndex: i + 10,
          name: `Sample ${100 + i}`,
          nameNorm: `sample ${100 + i}`,
          section: 'Traits',
          cell: { plain: `Mechanics ${i}`, runs: [{ text: `Mechanics ${i}` }] },
        })),
      },
    ],
  };
  const editor: EditorData = {
    items: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        100 + i,
        {
          hash: 100 + i,
          name: `Sample ${100 + i}`,
          categoryId: 'weapon-trait',
          icon: '',
          inGameDescription: `Mechanics ${i}`,
        },
      ]),
    ),
    categories: [],
    aliases: {},
    generatorAliases: {},
    bundle: {
      sourceCommit: 'synthetic',
      generatedAt: timestamp,
      permissions: { users: {} },
      pushed: {},
      tooltips: Object.fromEntries(
        Object.entries(texts).map(([hash, text]) => [
          hash,
          { hash: Number(hash), text: { en: { text, updatedAt: timestamp, updatedBy: 'test' } }, associated: [] },
        ]),
      ),
    },
  };
  const fingerprint = sourceFingerprint(source.tabs);
  const baseline = `synthetic|${fingerprint}`;
  const build = (target: EditorData) => {
    const entries = reviewQueue(target, source, {}, emptyProgress(), fingerprint);
    const proposals = new Map(
      entries.map((entry) => [entry.hash, proposalFor(entry.base, target, source)]),
    );
    return { entries, proposals, categories: reviewCategories(entries, target, proposals, false) };
  };
  return { source, editor, baseline, build, fingerprint };
}

function documentFor(
  categoryId: string,
  hashes: number[],
  references: Record<string, unknown>,
  baseline: string,
) {
  return guidanceSchema.parse({
    version: 1,
    scope: 'synthetic-only',
    baseline,
    categories: {
      [categoryId]: {
        id: categoryId,
        name: 'Weapon traits',
        rule: '',
        active: true,
        count: hashes.length,
        hashes,
        comment: '',
        references,
      },
    },
  });
}

const reference = (
  context: { categories: ReturnType<typeof reviewCategories>; proposals: Map<number, ReturnType<typeof proposalFor>> },
  hash: number,
  f: ReturnType<typeof fixture>,
) => {
  const category = context.categories[0];
  const entry = category.entries.find((candidate) => candidate.hash === hash)!;
  return sampleReference(
    entry,
    category.id,
    f.baseline,
    '',
    'accepted',
    context.proposals.get(hash)?.match,
    f.source,
  );
};

it('keeps owner evidence when an accepted alias group adopts the member', () => {
  const f = fixture();
  const plain = f.build(f.editor);
  const entry = plain.categories[0].entries.find((candidate) => candidate.hash === 101)!;
  const member = reference(plain, 101, f);

  // Adopt 101 into 100's accepted name group: the member's tooltip now lives on 100.
  f.editor.aliases = { 101: { to: 100, kind: 'name' } };
  f.editor.generatorAliases = {};
  f.editor.bundle.aliasGroups = {
    version: 1,
    groups: {
      100: { members: [100, 101], kind: 'S', basis: { name: 'sample 100', categoryId: 'weapon-trait' }, by: { id: '1', login: 'test' }, at: timestamp },
    },
    rejected: {},
  } as unknown as EditorData['bundle']['aliasGroups'];
  const grouped = f.build(f.editor);
  expect(grouped.categories[0].entries.some((candidate) => candidate.hash === 101)).toBe(false);
  const canonical = grouped.categories[0].entries.find((candidate) => candidate.hash === 100)!;
  expect(canonical.groupMembers).toEqual([101]);

  // The member's evidence no longer replays, but its saved source proof still carries.
  expect(groupReferenceCurrent(member, canonical, f.source)).toBe(true);
  const categories = guidedDecisions(
    documentFor(grouped.categories[0].id, [100, 101, 102, 103, 104, 105], { 101: member }, f.baseline),
    grouped.categories,
    grouped.proposals,
    f.source,
    f.baseline,
    'synthetic-only',
  );
  const decision = categories[0].entries.find((candidate) => candidate.hash === 100)!;
  expect(decision).toMatchObject({ ruleId: 'alias-group-owner', action: 'link', confidence: 'high' });
  expect(decision.link).toEqual(currentReferenceLink(member, f.source));

  // Another category or a changed source does not carry the member's proof.
  expect(groupReferenceCurrent(member, { ...canonical, category: 'other' }, f.source)).toBe(false);
  const changed = structuredClone(f.source);
  changed.tabs[0].rows[1].cell = { plain: 'Changed', runs: [{ text: 'Changed' }] };
  expect(groupReferenceCurrent(member, canonical, changed)).toBe(false);
  expect(referenceCurrent(member, entry, f.baseline, f.source)).toBe(true);
});

it('groups owner evidence by the generator aliases, not adopted name groups', () => {
  const f = fixture();
  const before = f.build(f.editor).categories[0].entries.find((entry) => entry.hash === 100)!;
  f.editor.aliases = { 101: { to: 100, kind: 'name' } };
  f.editor.generatorAliases = {};
  const after = f.build(f.editor).categories[0].entries.find((entry) => entry.hash === 100)!;
  expect(after.sampleEvidence).toBe(before.sampleEvidence);
  expect(after.evidenceManifest).toEqual(before.evidenceManifest);
});

it('replays presentation-only owner text and never wording, numbers or symbols', () => {
  const f = fixture({ 100: 'Grants 10% (8🠚10) and <yellow DMT />' });
  const before = f.build(f.editor);
  const entry = before.categories[0].entries.find((candidate) => candidate.hash === 100)!;
  const owner = reference(before, 100, f);
  const text = (value: string) => {
    f.editor.bundle.tooltips[100] = {
      hash: 100,
      text: { en: { text: value, updatedAt: timestamp, updatedBy: 'test' } },
      associated: [],
    };
    return f
      .build(f.editor)
      .categories[0].entries.find((candidate) => candidate.hash === 100)!;
  };
  // Parser markup migrations: the same consumer text.
  expect(referenceCurrent(owner, text('Grants 10% (8<arrow/>10) and <exotic DMT />'), f.baseline, f.source)).toBe(true);
  expect(referenceCurrent(owner, text('Grants 10% (8<arrow/>11) and <exotic DMT />'), f.baseline, f.source)).toBe(false);
  expect(referenceCurrent(owner, text('Grants 11% (8<arrow/>10) and <exotic DMT />'), f.baseline, f.source)).toBe(false);
  expect(referenceCurrent(owner, text('Reduces 10% (8<arrow/>10) and <exotic DMT />'), f.baseline, f.source)).toBe(false);
  expect(entry.hash).toBe(100);
});

it('accepts formatting-only cell churn and refuses wording or number changes', () => {
  const f = fixture();
  const before = f.build(f.editor);
  const entry = before.categories[0].entries.find((candidate) => candidate.hash === 100)!;
  const owner = reference(before, 100, f);
  const row = f.source.tabs[0].rows[0];
  const setCell = (plain: string) => {
    row.cell = { plain, runs: [{ text: plain }] };
  };
  // Dash, quote and whitespace variants only.
  setCell('Mechanics\u200b  0');
  const reformatted = { ...owner };
  expect(currentReferenceLink(reformatted, f.source)).toBeDefined();
  // Word, number and symbol changes stay unconfident.
  setCell('Mechanics 1');
  expect(currentReferenceLink({ ...owner }, f.source)).toBeUndefined();
  setCell('Mechanic 0');
  expect(currentReferenceLink({ ...owner }, f.source)).toBeUndefined();
  expect(referenceCurrent(owner, entry, f.baseline, f.source)).toBe(false);
});

it('carries a relocated row only when its identical cell text exists exactly once', () => {
  const f = fixture();
  const before = f.build(f.editor);
  const owner = reference(before, 100, f);
  const rows = f.source.tabs[0].rows;
  // The recorded row is renamed; its text still exists exactly once elsewhere.
  rows[0].name = 'Sample 100 renamed';
  rows[0].nameNorm = 'sample 100 renamed';
  rows[0].cell = { plain: 'Changed', runs: [{ text: 'Changed' }] };
  rows.push({
    rowIndex: 40,
    name: 'Moved Sample',
    nameNorm: 'moved sample',
    cell: { plain: 'Mechanics 0', runs: [{ text: 'Mechanics 0' }] },
  });
  expect(currentReferenceLink(owner, f.source)?.rowKey).toBe('Moved Sample');
  rows.push({
    rowIndex: 41,
    name: 'Duplicate Sample',
    nameNorm: 'duplicate sample',
    cell: { plain: 'Mechanics 0', runs: [{ text: 'Mechanics 0' }] },
  });
  // A fresh sheet object: relocation indexes one immutable source per load.
  expect(currentReferenceLink(owner, structuredClone(f.source))).toBeUndefined();
});






