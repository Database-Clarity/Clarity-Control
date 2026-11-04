// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  selectCompendiumCells,
  type CompendiumGridCell,
  type CompendiumSheet,
} from '@clarity/core';
import { isPickerSeparator, pickerSeparatorLabelRow } from './pickerSeparators';
import { pickerBands } from './pickerBands';
import { pickerGridHtml } from './pickerGridMarkup';
import { PickerGrid } from './PickerGrid';
import { confirmCompendiumSelection } from './selection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const entry = (text: string): CompendiumGridCell => ({
  row: 2,
  col: 1,
  rowSpan: 19,
  cell: { plain: text, background: '#123456', runs: [{ text, bold: true, color: '#abcdef' }] },
});
const sheet = (text: string): CompendiumSheet => ({
  gid: '1',
  name: 'Generic',
  rows: [],
  grid: [entry(text)],
});
const html = (text: string, first = 1, last = 10) => {
  const tab = sheet(text),
    host = document.createElement('div');
  host.innerHTML = pickerBands(tab, first, last)
    .map(
      (band) =>
        `<table><tbody>${pickerGridHtml(tab, band.first, band.last, 3, first, last)}</tbody></table>`,
    )
    .join('');
  return host;
};
describe('separator spans do not couple row layout', () => {
  it.each(['', ' \n ', '-', '–', '—', '| · • _ = . --—'])(
    'splits %j without repeating rich content',
    (text) => {
      expect(isPickerSeparator(entry(text).cell)).toBe(true);
      const tab = sheet(text);
      expect(pickerBands(tab, 1, 10)).toEqual([
        { first: 1, last: 3 },
        { first: 4, last: 6 },
        { first: 7, last: 9 },
        { first: 10, last: 10 },
      ]);
      const host = html(text),
        pieces = [...host.querySelectorAll<HTMLTableCellElement>('td[data-separator]')];
      expect(pieces).toHaveLength(9);
      expect(
        pieces.every(
          (piece) =>
            piece.rowSpan === 1 &&
            piece.colSpan === 1 &&
            piece.style.backgroundColor === 'rgb(18, 52, 86)',
        ),
      ).toBe(true);
      expect(pieces.filter((piece) => piece.dataset.start === 'true')).toHaveLength(1);
      expect(pieces.filter((piece) => piece.dataset.end === 'true')).toHaveLength(1);
      expect(pieces.map((piece) => piece.textContent).join('')).toBe(text);
      expect(host.querySelectorAll('[data-multiline]')).toHaveLength(1);
      if (text)
        expect(host.querySelector('[data-multiline] span')?.getAttribute('style')).toContain(
          'font-weight:700',
        );
      expect(pieces.every((piece) => piece.dataset.cell === '2:1')).toBe(true);
    },
  );
  it.each(['-5%', 'N/A', '123', '…', 'x-y'])('keeps meaningful %j as a native span', (text) => {
    const host = html(text);
    expect(isPickerSeparator(entry(text).cell)).toBe(false);
    expect(host.querySelectorAll('td[data-separator]')).toHaveLength(0);
    expect(host.querySelector<HTMLTableCellElement>('[data-cell="2:1"]')?.rowSpan).toBe(9);
  });
  it('places one label at the native alignment row, including clipped windows', () => {
    const cell = entry('-');
    expect(pickerSeparatorLabelRow(cell, 1, 21, 'top')).toBe(2);
    expect(pickerSeparatorLabelRow(cell, 1, 21, 'middle')).toBe(11);
    expect(pickerSeparatorLabelRow(cell, 1, 21, 'bottom')).toBe(20);
    expect(pickerSeparatorLabelRow(cell, 5, 15)).toBe(5);
    expect(html('-', 5, 15).querySelectorAll('[data-multiline]')).toHaveLength(1);
  });
  it('selects every piece using the original identity and relative offset', () => {
    const tab = sheet('-'),
      rootHost = document.createElement('div'),
      root = createRoot(rootHost),
      onToggle = vi.fn();
    tab.grid!.push({ row: 1, col: 0, cell: { plain: 'Anchor', runs: [{ text: 'Anchor' }] } });
    const offsets = [{ dRow: 1, dCol: 1 }];
    const match = {
      tab,
      row: {
        name: 'Anchor',
        nameNorm: 'anchor',
        rowIndex: 1,
        anchor: { row: 1, col: 0 },
        cell: selectCompendiumCells(tab, { row: 1, col: 0 }, offsets)!,
      },
      cells: offsets,
    };
    const data = { fetchedAt: '2026-11-04T00:00:00Z', tabs: [tab] };
    const savedBefore = confirmCompendiumSelection(match, data);
    expect(savedBefore?.cells).toEqual(offsets);
    const props = {
      tab,
      firstRow: 1,
      lastRow: 10,
      columns: 3,
      anchor: { row: 1, col: 0 },
      onToggle,
    };
    act(() => root.render(createElement(PickerGrid, { ...props, offsets: [] })));
    const buttons = [...rootHost.querySelectorAll<HTMLButtonElement>('[data-separator] button')];
    expect(buttons).toHaveLength(9);
    for (const button of buttons) act(() => button.click());
    expect(onToggle.mock.calls.every(([offset]) => offset.dRow === 1 && offset.dCol === 1)).toBe(
      true,
    );
    act(() =>
      root.render(createElement(PickerGrid, { ...props, offsets: [{ dRow: 1, dCol: 1 }] })),
    );
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(selectCompendiumCells(tab, props.anchor, [{ dRow: 1, dCol: 1 }])?.plain).toBe('-');
    expect(tab.grid![0].rowSpan).toBe(19);
    expect(confirmCompendiumSelection(match, data)).toEqual({
      ...savedBefore,
      snapshotAt: expect.any(String),
    });
    expect(rootHost.querySelectorAll('[data-separator] strong')).toHaveLength(1);
    act(() => root.unmount());
  });
});
