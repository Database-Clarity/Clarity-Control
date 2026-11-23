import { describe, expect, it } from 'vitest';
import type { Lang, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import {
  editorPath,
  globalUsers,
  publishedOf,
  reviewRows,
  routedRow,
  rowKey,
  unitCount,
  unitName,
} from './globalRows';
import { kindOf } from './kinds';
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
  rows.map((row) => [row.name, kindOf(row, publishedOf(row, {}), {})?.kind]);

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
  it('lists each un-hidden export with its unchanged output and its real declaration', () => {
    const rows = reviewRows([pending(saved)], ready(hidden));
    expect(words(rows)).toEqual([
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
