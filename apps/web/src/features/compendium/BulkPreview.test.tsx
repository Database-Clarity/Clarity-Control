import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { createDraftStore } from '../../stores/drafts';
import { reviewQueue } from './reviewQueue';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { proposalFor } from './rapidReview';
import {
  BulkPreview,
  bulkPreviewCurrent,
  createBulkPreview,
  type BulkProposal,
} from './BulkPreview';
import { CategoryReview } from './CategoryReview';
import { GuidancePersistence } from './guidancePersistence';
import { reviewCategories } from './reviewCategories';

function fixture() {
  const date = '2026-11-01T00:00:00Z';
  const rows = Array.from({ length: 12 }, (_, i) => ({
    name: `Test ${String(i).padStart(2, '0')}`,
    nameNorm: `test ${String(i).padStart(2, '0')}`,
    rowIndex: 10 + i,
    section: 'Weapon Traits',
    cell: { plain: `Source ${i}`, runs: [{ text: `Source ${i}`, bold: true as const }] },
  }));
  const source: CompendiumData = {
    fetchedAt: date,
    tabs: [{ gid: '1662574278', name: 'Weapon Perks', rows }],
  };
  const editor: EditorData = {
    categories: [],
    aliases: {},
    items: Object.fromEntries(
      rows.map((row, i) => [
        100 + i,
        {
          hash: 100 + i,
          name: row.name,
          categoryId: 'weapon-trait',
          icon: '',
          inGameDescription: 'Manifest description',
        },
      ]),
    ),
    bundle: {
      sourceCommit: 'baseline',
      generatedAt: date,
      permissions: { users: {} },
      pushed: {},
      tooltips: Object.fromEntries(
        rows.map((_, i) => [
          100 + i,
          {
            hash: 100 + i,
            text: { en: { text: `English ${i}`, updatedAt: date, updatedBy: 'owner' } },
            associated: [200],
          },
        ]),
      ),
    },
  };
  const entries = reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs));
  const proposals = new Map(
    entries.map((entry) => [entry.hash, proposalFor(entry.base, editor, source)]),
  );
  const preview = createBulkPreview(editor, source, entries, proposals);
  return { editor, source, entries, proposals, preview };
}
function component(preview: ReturnType<typeof createBulkPreview>, page = 0, current = true) {
  const onAccept = vi.fn<(proposals: BulkProposal[]) => void>();
  const tree = BulkPreview({
    preview,
    page,
    current,
    canEdit: true,
    onAccept,
    onPage: vi.fn(),
    onCancel: vi.fn(),
  });
  const button = Children.toArray(tree.props.children).at(-1);
  if (!isValidElement<{ onClick: () => void; disabled: boolean }>(button))
    throw new Error('Missing bulk accept control');
  return { onAccept, button: button.props, html: renderToStaticMarkup(tree) };
}

it('disables category textareas and reload/save controls while disk reload is outstanding', async () => {
  const { editor, entries, proposals } = fixture();
  const persistence = new GuidancePersistence(
    'fixture',
    '/guidance',
    { getItem: () => null, setItem: () => {} },
    vi.fn<typeof fetch>(async () => Response.json({ document: null, revision: null })),
  );
  await persistence.start();
  const guidance = { ...persistence.getSnapshot(), reloading: true, persistence };
  const html = renderToStaticMarkup(
    createElement(CategoryReview, {
      editor,
      categories: reviewCategories(entries, editor, proposals, false),
      proposals,
      guidance,
      onReview: vi.fn(),
    }),
  );
  expect(html).toContain('Reloading disk guidance; editing is paused');
  expect(html).toMatch(/<textarea[^>]*disabled=""/);
  expect(html).toMatch(/<button disabled="">Reload disk guidance/);
  expect(html).not.toContain('Retry disk save');
  persistence.dispose();
});

it('the component accepts only the displayed ten of twelve proposals, preserving text and associations', async () => {
  const { preview } = fixture();
  const first = component(preview);
  expect(first.html).toContain('Test 09');
  expect(first.html).not.toContain('Test 10');
  expect(first.html).toContain('Accept 10 proposals on this page as drafts');
  first.button.onClick();
  const accepted = first.onAccept.mock.calls[0][0];
  expect(accepted.map(({ entry }) => entry.hash)).toEqual(
    Array.from({ length: 10 }, (_, i) => 100 + i),
  );
  const store = createDraftStore({ read: async () => ({}), write: async () => {} });
  await store.getState().hydrate();
  store.getState().updateDrafts(
    accepted.map(({ entry, link }) => ({
      base: entry.base,
      update: (next) => ({ ...next, compendium: link }),
    })),
  );
  expect(Object.keys(store.getState().drafts)).toHaveLength(10);
  expect(store.getState().drafts[110]).toBeUndefined();
  expect(store.getState().drafts[111]).toBeUndefined();
  expect(store.getState().drafts[100].next.text).toEqual(preview.proposals[0].entry.next.text);
  expect(store.getState().drafts[100].next.associated).toEqual([200]);
  const second = component(preview, 1);
  expect(second.html).not.toContain('Test 09');
  expect(second.html).toContain('Test 11');
  second.button.onClick();
  expect(second.onAccept.mock.calls[0][0].map(({ entry }) => entry.hash)).toEqual([110, 111]);
});
it('freezes membership at opening instead of expanding when filters change', () => {
  const { editor, source, entries, proposals } = fixture();
  const preview = createBulkPreview(editor, source, entries.slice(0, 2), proposals);
  expect(bulkPreviewCurrent(preview, editor, source, entries, proposals, {})).toBe(true);
  const rendered = component(preview);
  expect(rendered.html).not.toContain('Test 02');
  rendered.button.onClick();
  expect(rendered.onAccept.mock.calls[0][0].map(({ entry }) => entry.hash)).toEqual([100, 101]);
});
it('invalidates changed source, catalog, proposal, status, evidence and in-flight drafts', () => {
  const { editor, source, entries, proposals, preview } = fixture();
  const current = (next = entries, matches = proposals, drafts = {}) =>
    bulkPreviewCurrent(preview, editor, source, next, matches, drafts);
  expect(current()).toBe(true);
  expect(bulkPreviewCurrent(preview, editor, { ...source }, entries, proposals, {})).toBe(false);
  expect(bulkPreviewCurrent(preview, { ...editor }, source, entries, proposals, {})).toBe(false);
  expect(current(entries.map((entry, i) => (i ? entry : { ...entry, evidence: 'changed' })))).toBe(
    false,
  );
  expect(
    current(entries.map((entry, i) => (i ? entry : { ...entry, status: 'skipped' as const }))),
  ).toBe(false);
  const changed = new Map(proposals);
  const first = changed.get(100)!;
  changed.set(100, { ...first, link: { ...first.link!, rowKey: 'changed' } });
  expect(current(entries, changed)).toBe(false);
  const base = entries[0].base;
  expect(
    current(entries, proposals, {
      100: { base, next: { ...base, associated: [201] } },
    }),
  ).toBe(false);
  const stale = component(preview, 0, false);
  expect(stale.html).toContain('Preview evidence or drafts changed');
  expect(stale.button.disabled).toBe(true);
  stale.button.onClick();
  expect(stale.onAccept).not.toHaveBeenCalled();
});
