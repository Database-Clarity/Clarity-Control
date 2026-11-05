// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import * as cellRendering from './RichCell';
import {
  preloadReviewFontMetrics,
  useReviewFontMetrics,
  warmReviewFontMetrics,
} from './reviewFontMetrics';

let pending: Map<number, IdleRequestCallback>;
let now: number;
let input: boolean;
let calls: { font: string; text: string }[];
const family = 'Arial, Helvetica, DestinySymbols, "Segoe UI Symbol", sans-serif';
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pending = new Map();
  calls = [];
  now = 0;
  input = false;
  let serial = 0;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    pending.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => pending.delete(id));
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => input } });
  vi.stubGlobal('scheduler', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const context = {
    font: '',
    measureText(text: string) {
      calls.push({ font: this.font, text });
      now += 2; // A slow native call exhausts this slice's wall-clock budget.
      return {} as TextMetrics;
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function tick(remaining = 10) {
  const [id, callback] = pending.entries().next().value!;
  pending.delete(id);
  callback({ didTimeout: false, timeRemaining: () => remaining });
}

it('waits for idle time, pauses for pending input, yields after a slow unit, and cancels', async () => {
  const cancel = warmReviewFontMetrics(guidedFixture().source, family, 16);
  await Promise.resolve();
  tick(0);
  expect(calls).toHaveLength(0);
  input = true;
  tick();
  expect(calls).toHaveLength(0);
  input = false;
  tick();
  expect(calls).toHaveLength(1);
  expect(pending.size).toBe(1);
  cancel();
  expect(pending.size).toBe(0);
});

it('yields after a slow source projection, and pauses projection work for pending input', async () => {
  const projection = vi.spyOn(cellRendering, 'prepareReviewCell').mockImplementation(() => {
    now += 2;
    return [];
  });
  const cancel = warmReviewFontMetrics(guidedFixture().source, family, 16);
  await Promise.resolve();
  tick();
  expect(projection).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(0);
  input = true;
  tick();
  expect(projection).toHaveBeenCalledTimes(1);
  cancel();
  expect(pending.size).toBe(0);
});

it('preloads the full source fairly while idle, and pauses before even reading the Editor style', async () => {
  const styles = vi
    .spyOn(window, 'getComputedStyle')
    .mockReturnValue({ fontSize: '16px' } as CSSStyleDeclaration);
  const cancel = preloadReviewFontMetrics(guidedFixture().source);
  expect(styles).not.toHaveBeenCalled();
  input = true;
  tick();
  expect(styles).not.toHaveBeenCalled();
  input = false;
  tick();
  await Promise.resolve();
  expect(styles).toHaveBeenCalledTimes(1);
  tick();
  expect(calls).toHaveLength(1);
  input = true;
  tick();
  expect(calls).toHaveLength(1);
  cancel();
  expect(pending.size).toBe(0);
});

it('prepares every source style with Latin text only, and invalidates for source or scale changes', async () => {
  const source = structuredClone(guidedFixture().source);
  source.tabs[0].rows[0].cell.runs.push({ text: '🛸', bold: true, italic: true, sizePt: 11 });
  source.tabs[0].grid = [
    {
      row: 1,
      col: 0,
      cell: {
        plain: 'Nearby caption',
        runs: [{ text: 'Nearby caption', italic: true, sizePt: 10 }],
      },
    },
  ];
  warmReviewFontMetrics(source, family, 16);
  await Promise.resolve();
  let ticks = 0;
  while (pending.size && ++ticks < 5000) tick();
  expect(pending.size).toBe(0);
  expect(calls.some(({ font }) => font === `italic 700 11pt ${family}`)).toBe(true);
  expect(calls.some(({ font }) => font === `italic 400 10pt ${family}`)).toBe(true);
  expect(calls.every(({ text }) => /^[\x20-\x7e]{1,8}$/.test(text))).toBe(true);
  const count = calls.length;
  warmReviewFontMetrics(source, family, 16);
  await Promise.resolve();
  expect(pending.size).toBe(0);
  expect(calls).toHaveLength(count);
  const cancelScale = warmReviewFontMetrics(source, family, 24);
  await Promise.resolve();
  expect(pending.size).toBe(1);
  cancelScale();
  const cancelRevision = warmReviewFontMetrics({ ...source }, family, 16);
  await Promise.resolve();
  expect(pending.size).toBe(1);
  cancelRevision();
});

it('cancels preparation when the review workspace unmounts', async () => {
  const source = guidedFixture().source;
  function Review() {
    const article = useRef<HTMLElement>(null);
    useReviewFontMetrics(article, source);
    return <article ref={article}>Review</article>;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Review />));
    expect(pending.size).toBe(1);
    const callback = pending.values().next().value!;
    await act(async () => root.unmount());
    expect(pending.size).toBe(0);
    callback({ didTimeout: false, timeRemaining: () => 10 });
    expect(calls).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it('defers computed-style reads beyond navigation, and keeps them paused while input is pending', async () => {
  const source = guidedFixture().source;
  const styles = vi.spyOn(window, 'getComputedStyle');
  function Review() {
    const article = useRef<HTMLElement>(null);
    useReviewFontMetrics(article, source);
    return <article ref={article}>Review</article>;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Review />));
    expect(styles).not.toHaveBeenCalled();
    input = true;
    tick();
    expect(styles).not.toHaveBeenCalled();
    input = false;
    await act(async () => tick());
    expect(styles).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it('uses cancellable background tasks between frames, and switches to idle waiting for input', async () => {
  let serial = 10000;
  const postTask = vi.fn(
    (callback: () => void, options: { priority: string; signal: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, () => {
          callback();
          resolve();
        });
        options.signal.addEventListener(
          'abort',
          () => {
            pending.delete(id);
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal('scheduler', { postTask });
  const cancel = warmReviewFontMetrics(guidedFixture().source, family, 16);
  await Promise.resolve();
  expect(postTask.mock.calls[0][1].priority).toBe('background');
  tick();
  expect(calls).toHaveLength(1);
  const scheduled = postTask.mock.calls.length;
  input = true;
  tick();
  expect(calls).toHaveLength(1);
  expect(postTask).toHaveBeenCalledTimes(scheduled);
  // Input waiting does not create a chain of runnable background tasks.
  tick();
  expect(postTask).toHaveBeenCalledTimes(scheduled);
  cancel();
  await Promise.resolve();
  expect(pending.size).toBe(0);
});
