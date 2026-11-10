// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, CompendiumSheet } from '@clarity/core';
import { pickerCellHtml, pickerGridHtml } from './pickerGridMarkup';
import { PickerGrid } from './PickerGrid';
import { RichCell } from './RichCell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cell = (plain: string): CompendiumCell => ({ plain, runs: [{ text: plain }] });
function dom(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}
const markup = (html: string) => {
  const host = dom(html);
  // The picker has no editor scale. Compare the equivalent 1× font spelling
  // without changing text, escaping, alignment, other styles, or link markup.
  for (const element of host.querySelectorAll('[style]')) {
    element.setAttribute(
      'style',
      element
        .getAttribute('style')!
        .replace(/(\bfont-size:\s*)calc\(([\d.]+pt) \* var\(--cell-scale, 1\)\)/g, '$1$2'),
    );
  }
  return host.innerHTML;
};
describe('picker presentation without per-cell React reconciliation', () => {
  it('matches RichCell text, styles, alignment, and blank/trailing lines with inert links', () => {
    const samples: CompendiumCell[] = [
      cell('<script>&"\'\n\nEnd'),
      cell(''),
      {
        plain: 'first\n\nsecond\n',
        runs: [
          {
            text: 'first\n',
            color: '#ff0000',
            bold: true,
            textAlign: 'center',
            href: 'https://example.com',
          },
          {
            text: '\nsecond\n',
            italic: true,
            underline: true,
            strike: true,
            sizePt: 12,
            textAlign: 'right',
          },
        ],
      },
      {
        plain: 'ab',
        runs: [
          { text: 'a', bold: true },
          { text: 'b', bold: true },
        ],
      },
    ];
    for (const sample of samples) {
      const expected = renderToStaticMarkup(
        createElement(RichCell, { cell: sample, links: false }),
      );
      expect(markup(pickerCellHtml(sample))).toBe(markup(expected));
    }
  });
  it('escapes source text and labels, and never interpolates unsafe CSS or links', () => {
    const malicious: CompendiumCell = {
      plain: '"><img src=x onerror=alert(1)>',
      runs: [
        { text: '"><img src=x onerror=alert(1)>', color: 'red; background:url(https://evil)' },
      ],
    };
    const tab: CompendiumSheet = {
      gid: '1',
      name: '',
      rows: [],
      grid: [{ row: 1, col: 0, cell: malicious }],
    };
    const host = dom(`<table><tbody>${pickerGridHtml(tab, 1, 2, 1)}</tbody></table>`);
    expect(host.querySelector('img,script,a')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      `Row 1, column 1: ${malicious.plain}`,
    );
    expect(host.querySelector('button')?.textContent).toBe(malicious.plain);
    expect(host.innerHTML).not.toContain('background:url');
  });
  it('clips a 19-row merged cell at both window edges, and caches by the full window', () => {
    const tab: CompendiumSheet = {
      gid: '1',
      name: '',
      rows: [],
      grid: [{ row: 2, col: 0, rowSpan: 19, colSpan: 2, cell: cell('merged') }],
    };
    const host = dom(`<table><tbody>${pickerGridHtml(tab, 5, 15, 2)}</tbody></table>`);
    expect(host.querySelectorAll('td')).toHaveLength(1);
    expect(host.querySelector('td')?.rowSpan).toBe(11);
    expect(host.querySelector('td')?.colSpan).toBe(2);
    expect(
      dom(`<table>${pickerGridHtml(tab, 1, 9, 2)}</table>`).querySelectorAll('tr'),
    ).toHaveLength(9);
    expect(
      dom(`<table>${pickerGridHtml(tab, 1, 10, 2)}</table>`).querySelectorAll('tr'),
    ).toHaveLength(10);
  });
  it('delegates rich-run clicks and updates selection order without replacing the grid', () => {
    const tab: CompendiumSheet = {
      gid: '1',
      name: '',
      rows: [],
      grid: [
        { row: 1, col: 0, cell: cell('anchor') },
        { row: 1, col: 1, cell: cell('description') },
      ],
    };
    const host = document.createElement('div'),
      root = createRoot(host),
      onToggle = vi.fn();
    const props = {
      tab,
      firstRow: 1,
      lastRow: 2,
      columns: 2,
      anchor: { row: 1, col: 0 },
      onToggle,
    };
    act(() => root.render(createElement(PickerGrid, { ...props, offsets: [] })));
    const button = host.querySelectorAll('button')[1];
    act(() => (button.querySelector('[data-multiline] span') as HTMLElement).click());
    expect(onToggle).toHaveBeenCalledWith({ dRow: 0, dCol: 1 });
    act(() =>
      root.render(createElement(PickerGrid, { ...props, offsets: [{ dRow: 0, dCol: 1 }] })),
    );
    expect(host.querySelectorAll('button')[1]).toBe(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('strong')?.textContent).toBe('(1) ');
    expect(button.querySelector('strong')?.hidden).toBe(false);
    act(() => root.unmount());
  });
});
