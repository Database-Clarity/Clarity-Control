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

it('fills a short first band without synchronously mounting the entire window', () => {
  let resize: ResizeObserverCallback;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const frames = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', frames);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(PickerGrid, props)));
    const viewport = host.querySelector<HTMLElement>('[role="region"]')!;
    const body = viewport.firstElementChild!;
    Object.defineProperty(viewport, 'clientHeight', { value: 240 });
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(
      () => ({ height: body.querySelectorAll('tr').length * 40 }) as DOMRect,
    );
    act(() =>
      resize!(
        [
          { target: body, contentRect: { height: 40 } },
          { target: viewport, contentRect: { height: 240 } },
        ] as ResizeObserverEntry[],
        {} as ResizeObserver,
      ),
    );
    expect(viewport.dataset.gridComplete).toBe('false');
    expect(host.querySelectorAll('tr')).toHaveLength(7);
    expect(host.querySelector('[data-cell="7:0"]')).not.toBeNull();
    expect(host.querySelector('[data-cell="8:0"]')).toBeNull();
    expect(frames).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it('updates old and new selected cells while retaining their original relative offsets', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  const host = document.createElement('div');
  const root = createRoot(host);
  const button = (row: number) => host.querySelector(`button[data-row="${row}"]`)!;
  try {
    act(() => root.render(createElement(PickerGrid, props)));
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

it('yields each hidden preparation band before revealing a complete visible pane', () => {
  const inputPending = vi.fn(() => true);
  vi.stubGlobal('navigator', { scheduling: { isInputPending: inputPending } });
  let resize: ResizeObserverCallback;
  let message: (() => void) | null = null;
  const posted = vi.fn();
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = {
        set onmessage(callback: (() => void) | null) {
          message = callback;
        },
        close() {
          message = null;
        },
      };
      port2 = { postMessage: posted, close() {} };
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const frames = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', frames);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div'),
    root = createRoot(host),
    onReady = vi.fn();
  try {
    act(() => root.render(createElement(PickerGrid, { ...props, onReady })));
    const viewport = host.querySelector<HTMLElement>('[role="region"]')!;
    const body = viewport.firstElementChild!;
    const notify = (height: number) =>
      act(() =>
        resize!(
          [
            { target: body, contentRect: { height } },
            { target: viewport, contentRect: { height: 100 } },
          ] as ResizeObserverEntry[],
          {} as ResizeObserver,
        ),
      );
    notify(40);
    expect(host.querySelectorAll('tr')).toHaveLength(1);
    expect(posted).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    act(() => message!());
    expect(host.querySelectorAll('tr')).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(frames).toHaveBeenCalledOnce();
    inputPending.mockReturnValue(false);
    frames.mockClear();
    act(() => message!());
    expect(host.querySelectorAll('tr')).toHaveLength(2);
    notify(80);
    expect(onReady).not.toHaveBeenCalled();
    act(() => message!());
    notify(120);
    expect(host.querySelectorAll('tr')).toHaveLength(3);
    expect(onReady).toHaveBeenCalledOnce();
    expect(viewport.dataset.gridComplete).toBe('false');
    expect(frames).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
  expect(message).toBeNull();
});
