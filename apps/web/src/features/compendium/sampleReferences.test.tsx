import { prepareMarkup } from '../../../../../packages/core/src/markup/prepare';
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
import { emptyProgress, rawFingerprint, sourceFingerprint } from './reviewProgress';
import { proposalFor } from './rapidReview';
import { categoryId, reviewCategories } from './reviewCategories';
import { rebaselineGuidance } from './rebaselineGuidance';
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

it('keeps arrow approvals and validated newer raw proofs, while rejecting changed mechanics', () => {
  const { source, editor, proposal } = fixture();
  const current = () =>
    reviewCategories(
      reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
      editor,
      new Map(),
      false,
    )[0].entries[0];
  editor.bundle.tooltips[10].text.en = {
    text: '#e5 #element',
    updatedAt: 'same',
    updatedBy: 'same',
  };
  const old = current();
  const ref = sampleReference(
    old,
    categoryId(old.category),
    `commit|${sourceFingerprint(source.tabs)}`,
    '',
    'accepted',
    proposal.match,
    source,
  );
  editor.bundle.tooltips[10].text.en!.text = '<enhanced/>5 #element';
  const entry = current();
  expect(entry.sampleEvidence).toBe(old.sampleEvidence);
  expect(referenceCurrent(ref, entry, ref.baseline, source)).toBe(true);
  const id = categoryId(entry.category);
  const document = guidanceSchema.parse({
    version: 1,
    scope: 'test',
    baseline: ref.baseline,
    categories: {
      [id]: {
        id,
        name: 'Traits',
        rule: '',
        count: 1,
        hashes: [10],
        active: true,
        comment: '',
        references: { 10: ref },
      },
    },
  });
  const categories = reviewCategories(
    reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
    editor,
    new Map(),
    false,
  );
  expect(rebaselineGuidance(document, categories, source, 'new', 'test').renewed).toEqual([10]);
  for (const text of [
    '<enhanced/>5 #elementChanged',
    '<enhanced/>5 #element\nvar e5 = 10',
    '<enhanced/>6 #element',
  ]) {
    const changed = structuredClone(editor);
    changed.bundle.tooltips[10].text.en!.text = text;
    const next = reviewCategories(
      reviewQueue(changed, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
      changed,
      new Map(),
      false,
    )[0].entries[0];
    expect(referenceCurrent(ref, next, ref.baseline, source)).toBe(false);
  }
  for (const hash of [rawFingerprint, sourceFingerprint]) {
    const evidence = hash([
      sourceFingerprint(source.tabs),
      entry.name,
      entry.category,
      entry.base.text.en,
      entry.base.compendium,
    ]);
    const raw = { ...ref, evidence: hash([entry.hash, evidence, entry.evidenceManifest]) };
    expect(referenceCurrent(raw, entry, ref.baseline, source)).toBe(true);
    expect(referenceCurrent({ ...raw, sourceHash: 'forged' }, entry, ref.baseline, source)).toBe(
      false,
    );
    const changed = structuredClone(editor);
    changed.bundle.tooltips[10].text.en!.text += ' extra mechanic';
    const next = reviewCategories(
      reviewQueue(changed, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
      changed,
      new Map(),
      false,
    )[0].entries[0];
    expect(referenceCurrent(raw, next, ref.baseline, source)).toBe(false);
  }
});

it.each([
  ['import main from 11', { '11': 'var e5 = 10' }],
  ['import vars from 11', { '11': 'export vars (\nvar e5 = 10\n)' }],
  ['import main from global', { '1': 'var e5 = 10' }],
  ['import main from 11', { '11': 'import main from 12', '12': 'var e5 = 10' }],
] as const)('invalidates numeric arrow changes with imported variables: %s', (line, imports) => {
  const { source, editor, proposal } = fixture();
  const oldText = `${line}\n#e5`;
  const newText = `${line}\n<enhanced/>5`;
  const globals = { variables: 'var e = ARROW', titles: '', imports };
  expect(prepareMarkup(oldText, globals, []).text).toBe('10');
  expect(prepareMarkup(newText, globals, []).text).toBe('ARROW5');
  const categories = () =>
    reviewCategories(
      reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
      editor,
      new Map(),
      false,
    );
  editor.bundle.tooltips[10].text.en = { text: oldText, updatedAt: 'same', updatedBy: 'same' };
  const before = categories()[0].entries[0];
  const baseline = `commit|${sourceFingerprint(source.tabs)}`;
  const id = categoryId(before.category);
  const ref = sampleReference(before, id, baseline, '', 'accepted', proposal.match, source);
  const document = guidanceSchema.parse({
    version: 1,
    scope: 'test',
    baseline,
    categories: {
      [id]: {
        id,
        name: 'Traits',
        rule: '',
        count: 1,
        hashes: [10],
        active: true,
        comment: '',
        references: { 10: ref },
      },
    },
  });
  editor.bundle.tooltips[10].text.en!.text = newText;
  const after = categories();
  expect(after[0].entries[0].sampleEvidence).not.toBe(before.sampleEvidence);
  expect(referenceCurrent(ref, after[0].entries[0], baseline, source)).toBe(false);
  const result = rebaselineGuidance(document, after, source, 'new', 'test');
  expect(result.renewed).toEqual([]);
  expect(result.changed.map((entry) => entry.hash)).toEqual([10]);
});

it.each([
  ['var e5x = 10\n#e5x', 'var e5x = 10\n<enhanced/>5x', '10', 'ARROW5x', false],
  ['var e5x = 10\n#e', 'var e5x = 10\n<enhanced/>', 'ARROW', 'ARROW', true],
  ['#e', '<enhanced/>', 'ARROW', 'ARROW', true],
] as const)(
  'validates local-variable and plain-arrow approvals: %s',
  (oldText, newText, oldOutput, newOutput, valid) => {
    const { source, editor, proposal } = fixture();
    const globals = { variables: 'var e = ARROW', titles: '' };
    expect(prepareMarkup(oldText, globals, []).text).toBe(oldOutput);
    expect(prepareMarkup(newText, globals, []).text).toBe(newOutput);
    const categories = () =>
      reviewCategories(
        reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs)),
        editor,
        new Map(),
        false,
      );
    editor.bundle.tooltips[10].text.en = { text: oldText, updatedAt: 'same', updatedBy: 'same' };
    const before = categories()[0].entries[0];
    const baseline = `commit|${sourceFingerprint(source.tabs)}`;
    const id = categoryId(before.category);
    const ref = sampleReference(before, id, baseline, '', 'accepted', proposal.match, source);
    const document = guidanceSchema.parse({
      version: 1,
      scope: 'test',
      baseline,
      categories: {
        [id]: {
          id,
          name: 'Traits',
          rule: '',
          count: 1,
          hashes: [10],
          active: true,
          comment: '',
          references: { 10: ref },
        },
      },
    });
    editor.bundle.tooltips[10].text.en!.text = newText;
    const after = categories();
    expect(after[0].entries[0].sampleEvidence === before.sampleEvidence).toBe(valid);
    expect(referenceCurrent(ref, after[0].entries[0], baseline, source)).toBe(valid);
    const result = rebaselineGuidance(document, after, source, 'new', 'test');
    expect(result.renewed).toEqual(valid ? [10] : []);
    expect(result.changed.map((entry) => entry.hash)).toEqual(valid ? [] : [10]);
  },
);
