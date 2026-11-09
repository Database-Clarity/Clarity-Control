import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useCompendiumStore } from './store';
import { LinkPicker } from './LinkPicker';
import { guidanceSchema } from './guidanceSchema';
import { mayDraftLink, reviewQueue } from './reviewQueue';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { proposalFor } from './rapidReview';
import { categoryId, reviewCategories } from './reviewCategories';
import { referenceCurrent, sampleReference } from './sampleReferences';

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    useCompendiumStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useCompendiumStore.getState>) => unknown) =>
        selector(actual.useCompendiumStore.getState()),
      actual.useCompendiumStore,
    ),
  };
});

function fixture() {
  const source: CompendiumData = {
    fetchedAt: '2026-11-01T00:00:00Z',
    tabs: [
      {
        gid: '1662574278',
        name: 'Weapon Perks',
        rows: [
          {
            rowIndex: 10,
            name: 'Test',
            nameNorm: 'test',
            cell: { plain: 'Source', runs: [{ text: 'Source', bold: true }] },
          },
        ],
      },
    ],
  };
  const editor: EditorData = {
    categories: [{ id: 'weapon-trait', label: 'Weapon traits', group: 'Weapons', order: 1 }],
    aliases: {},
    items: {
      10: {
        hash: 10,
        name: 'Test',
        categoryId: 'weapon-trait',
        inGameDescription: 'Manifest text',
        icon: '',
      },
    },
    bundle: {
      sourceCommit: 'test',
      generatedAt: source.fetchedAt,
      permissions: { users: {} },
      pushed: {},
      tooltips: { 10: { hash: 10, text: {}, associated: [] } },
    },
  };
  const queued = reviewQueue(
    editor,
    source,
    {},
    emptyProgress(),
    sourceFingerprint(source.tabs),
  )[0];
  const proposal = proposalFor(queued.base, editor, source);
  const entry = reviewCategories([queued], editor, new Map([[queued.hash, proposal]]), false)[0]
    .entries[0];
  return { source, editor, entry, proposal };
}
afterEach(() => {
  useAuthStore.setState({ user: null });
  useCompendiumStore.setState({ data: null });
  vi.restoreAllMocks();
});
it('records confirmed source identity, styled evidence and notes without changing tooltip data', () => {
  const { entry, proposal, source } = fixture();
  const before = JSON.stringify(entry);
  const reference = sampleReference(
    entry,
    categoryId(entry.category),
    'baseline',
    'Mechanics match',
    'accepted',
    proposal.match,
    source,
  );
  expect(reference).toMatchObject({
    hash: 10,
    name: 'Test',
    categoryId: 'catalog:weapon-trait',
    decision: 'accepted',
    sourceName: 'Test',
    sourceTab: 'Weapon Perks',
    sourceRow: 10,
    note: 'Mechanics match',
    link: { snapshot: { runs: [{ text: 'Source', bold: true }] } },
  });
  expect(reference.sourceHash).toBeTruthy();
  expect(referenceCurrent(reference, entry, 'baseline', source)).toBe(true);
  expect(JSON.stringify(entry)).toBe(before);
  expect(() =>
    sampleReference(entry, categoryId(entry.category), 'baseline', '', 'picked'),
  ).toThrow('uniquely resolvable');
});
it('invalidates references after entry/baseline/source changes and distinguishes skip from resolution', () => {
  const { entry, proposal, source } = fixture();
  const reference = sampleReference(
    entry,
    categoryId(entry.category),
    'baseline',
    '',
    'picked',
    proposal.match,
    source,
  );
  expect(
    referenceCurrent(reference, { ...entry, sampleEvidence: 'changed' }, 'baseline', source),
  ).toBe(false);
  expect(referenceCurrent(reference, { ...entry, hash: 11 }, 'baseline', source)).toBe(false);
  expect(referenceCurrent(reference, { ...entry, category: 'other' }, 'baseline', source)).toBe(
    false,
  );
  expect(referenceCurrent(reference, entry, 'new baseline', source)).toBe(false);
  source.tabs[0].rows[0].cell.runs[0].bold = undefined;
  expect(referenceCurrent(reference, entry, 'baseline', source)).toBe(false);
  const skipped = sampleReference(
    entry,
    categoryId(entry.category),
    'baseline',
    'Not sure',
    'skipped',
  );
  expect(skipped.link).toBeUndefined();
  expect(
    sampleReference(entry, categoryId(entry.category), 'baseline', '', 'no-equivalent').link,
  ).toBeUndefined();
  expect(
    sampleReference(entry, categoryId(entry.category), 'baseline', 'Only a note').decision,
  ).toBeUndefined();
});
it('keeps ordinary linking gated for signed-out users while the reference picker stays usable', () => {
  const { entry, source } = fixture();
  useAuthStore.setState({ user: null });
  useCompendiumStore.setState({ data: source });
  const drafts = useDraftStore.getState().drafts;
  const ordinary = renderToStaticMarkup(
    createElement(LinkPicker, {
      base: entry.base,
      name: entry.name,
      category: entry.category,
      onLinked: vi.fn(),
    }),
  );
  expect(ordinary).toContain('Linking creates a local draft; save it normally.');
  expect(mayDraftLink(undefined, true, true, false)).toBe(false);
  const referencePicker = renderToStaticMarkup(
    createElement(LinkPicker, {
      base: entry.base,
      name: entry.name,
      category: entry.category,
      onLinked: vi.fn(),
      onReference: vi.fn(),
    }),
  );
  expect(referencePicker).not.toMatch(/<button type="button" disabled="">/);
  expect(referencePicker).toContain('local reference only');
  expect(useDraftStore.getState().drafts).toBe(drafts);
});
it('validates reference identity and decision/source consistency while accepting legacy comment-only documents', () => {
  const { entry, source, proposal } = fixture();
  const id = categoryId(entry.category);
  const category = {
    id,
    name: 'Traits',
    rule: 'Traits',
    count: 1,
    hashes: [10],
    active: true,
    comment: 'Keep this',
  };
  const document = {
    version: 1,
    scope: 'test',
    baseline: 'baseline',
    categories: { [id]: category },
  };
  expect(guidanceSchema.parse(document)).toEqual(document);
  const reference = sampleReference(
    entry,
    id,
    'baseline',
    'Keep note',
    'accepted',
    proposal.match,
    source,
  );
  const withReference = {
    ...document,
    categories: { [id]: { ...category, references: { 10: reference } } },
  };
  expect(guidanceSchema.parse(withReference)).toEqual(withReference);
  expect(
    guidanceSchema.safeParse({
      ...document,
      categories: { [id]: { ...category, references: { 11: reference } } },
    }).success,
  ).toBe(false);
  expect(
    guidanceSchema.safeParse({
      ...document,
      categories: { [id]: { ...category, references: { 10: { ...reference, link: undefined } } } },
    }).success,
  ).toBe(false);
});
