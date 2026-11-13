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

/**
 * Renders the grid with layout costing `perRow` ms per newly laid-out row (on a mocked clock),
 * 40 px rows, and a 240 px region. Returns the row counts each task started with.
 */
function fillWith(perRow: number) {
  const callbacks: FrameRequestCallback[] = [];
  const frames = vi.fn((callback: FrameRequestCallback) => callbacks.push(callback));
  vi.stubGlobal('requestAnimationFrame', frames);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(createElement(PickerGrid, props)));
  const viewport = host.querySelector<HTMLElement>('[role="region"]')!;
  const body = viewport.firstElementChild!;
  Object.defineProperty(viewport, 'clientHeight', { value: 240 });
  let laidOut = 0;
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => {
    const count = body.querySelectorAll('tr').length;
    clock += Math.max(0, count - laidOut) * perRow;
    laidOut = count;
    return { height: count * 40 } as DOMRect;
  });
  return { host, root, viewport, frames, callbacks, rows: () => host.querySelectorAll('tr').length };
}

it('fills the region hidden in budgeted tasks, reveals, then finishes without frame waits', async () => {
  const grid = fillWith(1);
  try {
    // The input/commit task carries one band only; the rest is not laid out there.
    expect(grid.rows()).toBe(1);
    expect(grid.viewport.dataset.gridFilling).toBe('true');
    expect(grid.viewport.getAttribute('aria-busy')).toBe('true');
    expect(grid.viewport.style.visibility).toBe('hidden');
    await drainBands();
    // 1 ms per row against a 6 ms task budget: steps of 1, 2, 2 rows in the first task, then
    // 2 more, which overflow the region: revealed with 8 of 15 rows after two tasks.
    expect(grid.viewport.dataset.gridFilling).toBe('false');
    expect(grid.viewport.style.visibility).toBe('');
    expect(grid.viewport.dataset.gridComplete).toBe('false');
    expect(grid.rows()).toBe(8);
    expect(grid.frames).toHaveBeenCalledOnce();
    // The reveal paints on its own; the task after that frame mounts the rest (4 + 3 rows).
    act(() => grid.callbacks[0](0));
    await drainBands();
    expect(grid.rows()).toBe(15);
    expect(grid.viewport.dataset.gridComplete).toBe('true');
    expect(grid.frames).toHaveBeenCalledOnce();
  } finally {
    act(() => grid.root.unmount());
    vi.restoreAllMocks();
  }
});

it('keeps the unbudgeted step sizes when a row costs more than the budget', async () => {
  const grid = fillWith(8);
  const counts: number[] = [];
  const observer = new MutationObserver(() => counts.push(grid.rows()));
  observer.observe(grid.viewport, { childList: true, subtree: true });
  try {
    await drainBands();
    // The first task lays out the first band only; then 1, 2, 2, 2 rows per task (as before
    // budgeting) until the rows overflow the region.
    expect(grid.viewport.dataset.gridFilling).toBe('false');
    expect(grid.rows()).toBe(8);
    act(() => grid.callbacks[0](0));
    await drainBands();
    // Below the region: three rows per task, without frame waits.
    expect(grid.rows()).toBe(15);
    expect(grid.frames).toHaveBeenCalledOnce();
    expect([...new Set(counts)]).toEqual([2, 4, 6, 8, 11, 14, 15]);
  } finally {
    observer.disconnect();
    act(() => grid.root.unmount());
    vi.restoreAllMocks();
  }
});

it('lets timers that react to the reveal run before the fill continues', async () => {
  const grid = fillWith(1);
  const seen: number[] = [];
  // Like a paint stamp: on the reveal, wait for the next frame, then a timer.
  const observer = new MutationObserver(() => {
    if (grid.viewport.dataset.gridFilling !== 'false' || seen.length) return;
    seen.push(-1);
    requestAnimationFrame(() => setTimeout(() => seen.push(grid.rows()), 0));
  });
  observer.observe(grid.viewport, { attributes: true });
  try {
    await drainBands();
    expect(grid.rows()).toBe(8);
    // Both frame callbacks run in the reveal's frame, the stamp's first.
    expect(grid.callbacks).toHaveLength(2);
    act(() => grid.callbacks.forEach((callback) => callback(0)));
    await drainBands();
    expect(seen).toEqual([-1, 8]);
    expect(grid.rows()).toBe(15);
  } finally {
    observer.disconnect();
    act(() => grid.root.unmount());
    vi.restoreAllMocks();
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
