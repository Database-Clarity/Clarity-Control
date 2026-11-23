import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import {
  editorLabel,
  editorPath,
  globalUsers,
  publishedOf,
  reviewRows,
  routedRow,
  rowKey,
  unitCount,
  unitName,
  unresolvedRow,
} from './globalRows';
import { classifyRows, kindOf, useKinds } from './kinds';
import { initialReviewParams } from './route';
import { publishableHashes, type PendingTooltip } from './model';
import { queueView } from './queueModel';
import type { usePublished } from './published';

const file = (hash: number, texts: Partial<Record<Lang, string>>): Tooltip => ({
  hash,
  custom: { name: 'Global exports', categoryId: 'none' },
  text: Object.fromEntries(
    Object.entries(texts).map(([lang, text]) => [
      lang,
      { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' },
    ]),
  ),
  associated: [],
});
const pending = (
  tooltip: Tooltip,
  extra: Partial<PendingTooltip> = { pushed: 'marker' },
): PendingTooltip => ({
  tooltip,
  name: tooltip.custom!.name,
  category: 'Globals',
  categoryId: '~globals',
  categoryOrder: 99,
  markerOnly: false,
  isNew: false,
  ...extra,
});
const ready = (tooltip: Tooltip): ReturnType<typeof usePublished.getState>['byHash'] => ({
  [tooltip.hash]: { status: 'ready', tooltip, marker: 'marker' },
});
const block = (name: string, body: string, word = 'export') => `${word} ${name} (\n${body}\n)`;
const exportsFile = (...blocks: string[]) => file(1, { en: blocks.join('\n\n') });
const words = (rows: PendingTooltip[]) =>
  rows.map((row) => [
    row.name,
    kindOf(row, publishedOf(row, {}), useKinds.getState().byHash)?.kind,
  ]);
/** The real rendered check of every row, as the page asks for it. */
async function classified(rows: PendingTooltip[]) {
  const saved = rows[0]!.part!.unit.tooltip;
  classifyRows(
    rows.map((entry) => ({ entry, published: publishedOf(entry, {}) })),
    {
      bundle: { tooltips: { [saved.hash]: saved } },
      aliases: {},
      items: {},
      categories: [],
    } as unknown as EditorData,
  );
  await vi.waitFor(() => expect(words(rows).every(([, word]) => word)).toBe(true));
  return words(rows);
}
beforeEach(() => useKinds.setState({ byHash: {} }));

const saved = exportsFile(
  block('anti_barrier', 'Barrier'),
  block('overload', 'Two\nlines'),
  block('unstoppable', 'Stop'),
);
const hidden = exportsFile(
  block('anti_barrier', 'Barrier', 'export hidden'),
  block('overload', 'Two\nlines', 'export hidden'),
  block('unstoppable', 'Stop', 'export hidden'),
);

describe('globals files as rows', () => {
  it('lists each un-hidden export with its unchanged output and its real declaration', async () => {
    const rows = reviewRows([pending(saved)], ready(hidden));
    expect(await classified(rows)).toEqual([
      ['anti_barrier', 'Output unchanged'],
      ['overload', 'Output unchanged'],
      ['unstoppable', 'Output unchanged'],
    ]);
    expect(rows[1]!.part!.source).toEqual({
      before: { en: 'export hidden overload (\nTwo\nlines\n)' },
      after: { en: 'export overload (\nTwo\nlines\n)' },
    });
    expect(rows[1]!.tooltip.text.en!.text).toBe('Two\nlines');
    expect(rows.map(editorPath)).toEqual([
      '/t/1?global=anti_barrier',
      '/t/1?global=overload',
      '/t/1?global=unstoppable',
    ]);
  });

  it('compares a changed body, and leaves out entries that did not change', () => {
    const rows = reviewRows(
      [pending(exportsFile(block('a', 'Same'), block('b', 'After'), block('d', 'Added')))],
      ready(exportsFile(block('a', 'Same'), block('b', 'Before'), block('c', 'Dropped'))),
    );
    expect(words(rows)).toEqual([
      // Decided by the rendered comparison, like any tooltip.
      ['b', undefined],
      ['c', 'Removed'],
      ['d', 'New'],
    ]);
    expect(publishedOf(rows[0]!, {})).toMatchObject({
      status: 'ready',
      tooltip: { text: { en: { text: 'Before' } } },
    });
  });

  it('says the text changed when an identical body uses an entry that changed', async () => {
    const rows = reviewRows(
      [pending(exportsFile(block('leaf', 'New'), block('parent', 'import leaf from 1')))],
      ready(
        exportsFile(
          block('leaf', 'Old'),
          block('parent', 'import leaf from global', 'export hidden').replace('global', '1'),
        ),
      ),
    );
    expect(await classified(rows)).toEqual([
      ['leaf', 'Text changed'],
      ['parent', 'Text changed'],
    ]);
    const variables = reviewRows(
      [pending(file(2, { en: 'var a = 2\nvar b =  #a' }))],
      ready(file(2, { en: 'var a = 1\nvar b = #a' })),
    );
    expect(variables.map(({ name }) => name)).toEqual(['a', 'b']);
  });

  it('compares the language a file goes live in: a fallback drops a definition only it had', () => {
    const german = (english: string): Tooltip => {
      const tooltip = file(1, {
        en: block('a', 'A'),
        de: `${block('a', 'Ä')}\n\n${block('b', 'B')}`,
      });
      tooltip.text.en!.updatedAt = english;
      tooltip.text.de!.sourceUpdatedAt = '2026-01-01T00:00:00Z';
      return tooltip;
    };
    const rows = reviewRows(
      [pending(german('2026-11-01T00:00:00Z'))],
      ready(german('2026-01-02T00:00:00Z')),
    );
    expect(rows.map(({ name }) => name)).toEqual(['a', 'b']);
    expect(rows[0]!.tooltip.text.de!.text).toBe('A');
    expect(publishedOf(rows[0]!, {})).toMatchObject({ tooltip: { text: { de: { text: 'Ä' } } } });
    expect(rows[1]!.part).toMatchObject({ removed: true });
    // It no longer goes live, but it is still saved: its own page opens.
    expect(editorPath(rows[1]!)).toBe('/t/1?global=b');
  });

  it('lists the published entries as removed when the saved file has none left', () => {
    const rows = reviewRows([pending(file(1, { en: '// nothing left' }))], ready(hidden));
    expect(words(rows)).toEqual([
      ['anti_barrier', 'Removed'],
      ['overload', 'Removed'],
      ['unstoppable', 'Removed'],
    ]);
    expect(rows.map(editorPath)).toEqual(Array(3).fill('/t/1'));
    expect(rows.map(editorLabel)).toEqual(Array(3).fill('Open globals'));
  });

  it('keeps a link to an entry the published file may still list', () => {
    const entries = [pending(exportsFile(block('a', 'A')))];
    const cold = reviewRows(entries, {});
    expect(unresolvedRow(cold, '1:gone', {})).toBe(true);
    expect(unresolvedRow(cold, '1:a', {})).toBe(false);
    expect(unresolvedRow(cold, '1', {})).toBe(false);
    expect(initialReviewParams(new URLSearchParams('hash=1:gone'), cold).get('hash')).toBe(
      '1:gone',
    );
    expect(initialReviewParams(new URLSearchParams('hash=1'), cold).get('hash')).toBe('1:a');
    const known = ready(exportsFile(block('gone', 'G')));
    expect(routedRow(reviewRows(entries, known), '1:gone')?.name).toBe('gone');
    expect(unresolvedRow(reviewRows(entries, known), '1:other', known)).toBe(false);
    const failed = { 1: { status: 'error' as const, error: 'x', marker: 'marker' } };
    expect(unresolvedRow(reviewRows(entries, failed), '1:gone', failed)).toBe(false);
  });

  it('gives variables and titles rows too, per language', () => {
    const variables = reviewRows(
      [pending(file(2, { en: 'var a = 1\nvar b = 2', de: 'var a = 1\nvar b = 3' }))],
      ready(file(2, { en: 'var a = 1\nvar b = 2', de: 'var a = 1\nvar b = 2' })),
    );
    expect(variables.map(({ name }) => name)).toEqual(['b']);
    expect(variables[0]!.tooltip.text.de!.text).toBe('3');
    const titles = reviewRows(
      [pending(file(3, { en: block('Tip', 'New', 'title') }))],
      ready(file(3, { en: block('Tip', 'Old', 'title') })),
    );
    expect(titles.map(rowKey)).toEqual(['3:Tip']);
  });

  it('lists every saved entry without a word until the published file is known', () => {
    const entry = pending(saved);
    const unknown: Parameters<typeof reviewRows>[1][] = [
      {},
      { 1: { status: 'loading' as const, marker: 'marker' } },
      { 1: { status: 'error' as const, error: 'x', marker: 'marker' } },
      { 1: { status: 'missing' as const, marker: 'marker' } },
    ];
    for (const byHash of unknown)
      expect(words(reviewRows([entry], byHash))).toEqual([
        ['anti_barrier', undefined],
        ['overload', undefined],
        ['unstoppable', undefined],
      ]);
    expect(words(reviewRows([pending(saved, { isNew: true })], {}))[0]).toEqual([
      'anti_barrier',
      'New',
    ]);
  });

  it('keeps the file itself as the row when no entry accounts for its change', () => {
    const entry = pending(exportsFile('// note', block('a', 'Same')));
    expect(reviewRows([entry], ready(exportsFile(block('a', 'Same'))))).toEqual([entry]);
    const leftover = pending(saved, { markerOnly: true });
    expect(reviewRows([leftover], ready(hidden))).toEqual([leftover]);
  });

  it('keeps the same rows until the file’s own published text changes', () => {
    const entries = [pending(saved)];
    const byHash = ready(hidden);
    const rows = reviewRows(entries, byHash);
    expect(reviewRows(entries, { ...byHash, 10: { status: 'loading', marker: 'm' } })).toBe(rows);
    expect(reviewRows(entries, {})).not.toBe(rows);
    const other = [pending(file(10, { en: 'x' }), { categoryId: 'perks' })];
    expect(reviewRows(other, byHash)).toBe(other);
  });

  it('counts and ticks a file as one change', () => {
    const other = pending(file(10, { en: 'x' }), { categoryId: '~globals', name: 'Other' });
    const rows = reviewRows([pending(saved), other], ready(hidden));
    expect(rows).toHaveLength(4);
    expect(unitCount(rows)).toBe(2);
    expect(publishableHashes(rows)).toEqual([1, 10]);
    expect(rows.map(unitName)).toEqual([
      ...Array(3).fill('anti_barrier, overload, and unstoppable'),
      'Other',
    ]);
    const view = queueView(rows, '', '', new Set(), 'hidden');
    expect(view.items[0]).toMatchObject({
      label: 'Globals',
      count: 2,
      publishable: [1, 10],
      note: 'exports ticked together',
    });
    expect([...view.shown]).toEqual(['1:anti_barrier', '1:overload', '1:unstoppable', 10]);
    // A filter that shows one of the rows still says the tick covers all three.
    expect(queueView(rows, 'overload', '', new Set(), 'hidden').items[0]).toMatchObject({
      count: 1,
      note: 'ticked together',
    });
  });

  it('opens the row a link names; the file’s plain hash opens its first', () => {
    const rows = reviewRows([pending(saved)], ready(hidden));
    expect(routedRow(rows, '1:overload')?.name).toBe('overload');
    expect(routedRow(rows, '1')?.name).toBe('anti_barrier');
    expect(routedRow(rows, '1:gone')?.name).toBe('anti_barrier');
    expect(routedRow(rows, '10')).toBeUndefined();
  });

  it('counts the tooltips that use an entry', () => {
    const tooltips = {
      1: saved,
      10: file(10, { en: 'import overload from global' }),
      11: file(11, { en: 'import overload from 1\noverload', de: 'import overload from 1' }),
      12: file(12, { en: '// import overload from 1\noverload' }),
    };
    const data = { bundle: { tooltips } } as unknown as EditorData;
    const rows = reviewRows([pending(saved)], ready(hidden));
    expect(rows.map(({ part }) => globalUsers(part!, data))).toEqual([0, 2, 0]);
  });
});
