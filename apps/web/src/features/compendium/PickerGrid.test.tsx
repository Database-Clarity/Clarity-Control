// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { PickerGrid } from './PickerGrid';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

const tab: CompendiumSheet = {
  gid: '1',
  name: 'Ordinary rows',
  rows: [],
  grid: Array.from({ length: 15 }, (_, index) => ({
    row: index + 1,
    col: 0,
    cell: { plain: `Row ${index + 1}`, runs: [{ text: `Row ${index + 1}` }] },
  })),
};
const props = {
  tab,
  firstRow: 1,
  lastRow: 15,
  columns: 1,
  anchor: { row: 1, col: 0 },
  offsets: [],
  onToggle: () => {},
};

/** Lets the grid's own band tasks (MessageChannel) run to completion. */
async function drainBands() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('fills the region one band per task, hidden, then reveals and continues by frames', async () => {
  const frames = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', frames);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(PickerGrid, props)));
    const viewport = host.querySelector<HTMLElement>('[role="region"]')!;
    const body = viewport.firstElementChild!;
    // The input/commit task carries one band only; the rest is not laid out there.
    expect(host.querySelectorAll('tr')).toHaveLength(1);
    expect(viewport.dataset.gridFilling).toBe('true');
    expect(viewport.getAttribute('aria-busy')).toBe('true');
    expect(viewport.style.visibility).toBe('hidden');
    Object.defineProperty(viewport, 'clientHeight', { value: 240 });
    const heights: number[] = [];
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => {
      heights.push(body.querySelectorAll('tr').length);
      return { height: body.querySelectorAll('tr').length * 40 } as DOMRect;
    });
    await drainBands();
    // One band was added per task (each measured alone) until the rows overflow the region.
    expect(heights).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(viewport.dataset.gridFilling).toBe('false');
    expect(viewport.style.visibility).toBe('');
    expect(viewport.dataset.gridComplete).toBe('false');
    expect(host.querySelectorAll('tr')).toHaveLength(7);
    expect(host.querySelector('[data-cell="8:0"]')).toBeNull();
    expect(frames).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it('updates old and new selected cells while retaining their original relative offsets', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const button = (row: number) => host.querySelector(`button[data-row="${row}"]`)!;
  try {
    act(() => root.render(createElement(PickerGrid, props)));
    await drainBands();
    expect(button(1).getAttribute('aria-pressed')).toBe('false');
    act(() =>
      root.render(createElement(PickerGrid, { ...props, offsets: [{ dRow: 0, dCol: 0 }] })),
    );
    expect(button(1).getAttribute('aria-pressed')).toBe('true');
    expect(button(1).querySelector('strong')?.textContent).toBe('(1) ');
    act(() =>
      root.render(createElement(PickerGrid, { ...props, offsets: [{ dRow: 12, dCol: 0 }] })),
    );
    expect(button(1).getAttribute('aria-pressed')).toBe('false');
    expect(button(1).querySelector('strong')).toBeNull();
    expect(button(13).getAttribute('aria-pressed')).toBe('true');
    expect(button(13).querySelector('strong')?.textContent).toBe('(1) ');
    act(() => root.render(createElement(PickerGrid, props)));
    expect(button(13).getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('strong')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
