// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { CompendiumRow } from '@clarity/core';
import { PickerRowList, pickerRowListHtml } from './PickerRowList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const rows: CompendiumRow[] = Array.from({ length: 103 }, (_, i) => ({
  name: `Name ${i} <img src=x onerror="bad()"> & '`,
  nameNorm: `name ${i}`,
  rowIndex: i + 3,
  section: i % 2 ? 'Traits' : undefined,
  cell: { plain: 'source', runs: [{ text: 'source' }] },
}));

it('retains plain-text labels, exact promotion, escaped source text, and readonly controls', () => {
  const exact = new Set([rows[0]]);
  const host = document.createElement('div');
  host.innerHTML = pickerRowListHtml(rows.slice(0, 2), exact, true);
  const reference = document.createElement('div');
  reference.innerHTML = renderToStaticMarkup(
    createElement(
      'ul',
      null,
      rows
        .slice(0, 2)
        .map((row, i) =>
          createElement(
            'li',
            { key: i },
            createElement(
              'button',
              { type: 'button', disabled: true },
              exact.has(row) && 'Exact match: ',
              row.name,
              ' ',
              row.section && ` / ${row.section}`,
              ' ',
              createElement('small', null, `(row ${row.rowIndex})`),
            ),
            createElement('button', { type: 'button' }, 'Pick description cells near this name'),
          ),
        ),
    ),
  );
  expect(host.textContent).toBe(reference.textContent);
  expect(host.querySelectorAll('img')).toHaveLength(0);
  expect(host.querySelectorAll('button:disabled')).toHaveLength(2);
  expect(host.querySelectorAll('small')).toHaveLength(2);
});

it('delegates both actions to the original row and retains DOM/focus across anchor updates', () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const onChoose = vi.fn(),
    onAnchor = vi.fn(),
    exact = new Set<CompendiumRow>();
  const props = { rows, exact, disabled: false, onChoose, onAnchor };
  try {
    act(() => root.render(createElement(PickerRowList, props)));
    expect(host.querySelectorAll('li')).toHaveLength(100);
    const choose = host.querySelector<HTMLButtonElement>(
      '[data-picker-row="99"][data-picker-action="choose"]',
    )!;
    act(() =>
      choose.querySelector('small')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onChoose).toHaveBeenCalledWith(rows[99]);
    const anchor = host.querySelector<HTMLButtonElement>(
      '[data-picker-row="99"][data-picker-action="anchor"]',
    )!;
    anchor.focus();
    act(() => anchor.click());
    expect(onAnchor).toHaveBeenCalledWith(rows[99]);
    act(() => root.render(createElement(PickerRowList, { ...props, onAnchor: vi.fn() })));
    expect(document.activeElement).toBe(anchor);
    expect(host.querySelector('[data-picker-row="99"][data-picker-action="anchor"]')).toBe(anchor);
    act(() => root.render(createElement(PickerRowList, { ...props, disabled: true })));
    act(() => host.querySelector<HTMLButtonElement>('[data-picker-action="choose"]')!.click());
    expect(onChoose).toHaveBeenCalledTimes(1);
    act(() => host.querySelector<HTMLButtonElement>('[data-picker-action="anchor"]')!.click());
    expect(onAnchor).toHaveBeenCalledWith(rows[0]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
