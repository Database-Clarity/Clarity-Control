// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { useReviewFontMetrics, warmReviewFontMetrics } from './reviewFontMetrics';

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

it('prepares every source style with Latin text only, and invalidates for source or scale changes', async () => {
  const source = structuredClone(guidedFixture().source);
  source.tabs[0].rows[0].cell.runs.push({ text: '🛸', bold: true, italic: true, sizePt: 11 });
  warmReviewFontMetrics(source, family, 16);
  await Promise.resolve();
  let ticks = 0;
  while (pending.size && ++ticks < 5000) tick();
  expect(pending.size).toBe(0);
  expect(calls.some(({ font }) => font === `italic 700 11pt ${family}`)).toBe(true);
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
