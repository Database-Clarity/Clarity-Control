// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';

let clock: number;
let pending: boolean;
let serial: number;
let idle: Map<number, IdleRequestCallback>;
let measured: { font: string; text: string }[];
const source = () =>
  ({
    fetchedAt: '2026-11-05T00:00:00Z',
    tabs: [
      {
        rows: [
          {
            cell: {
              runs: [
                { text: 'Ordinary text', bold: true, sizePt: 9 },
                { text: 'Same size, regular', sizePt: 9 },
                { text: 'Same size, italic', italic: true, sizePt: 9 },
                { text: 'Same size, both', bold: true, italic: true, sizePt: 9 },
                { text: 'ツ 🛸', italic: true, sizePt: 7 },
                { text: '' },
              ],
            },
          },
        ],
        grid: [{ cell: { runs: [{ text: 'A grid-only face', sizePt: 11 }] } }],
      },
    ],
  }) as unknown as CompendiumData;

beforeEach(() => {
  vi.resetModules();
  clock = 0;
  pending = false;
  serial = 0;
  idle = new Map();
  measured = [];
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('navigator', {
    userAgent: 'Vitest',
    scheduling: { isInputPending: () => pending },
  });
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
  const context = {
    font: '',
    measureText(text: string) {
      measured.push({ font: this.font, text });
      clock += 2;
      return {};
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  vi.stubGlobal('performance', { now: () => clock, mark: vi.fn() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function runIdle(budget = 50) {
  const [id, callback] = idle.entries().next().value!;
  idle.delete(id);
  callback({ timeRemaining: () => budget, didTimeout: false });
}
function drain() {
  for (let count = 0; idle.size && count < 1000; count++) runIdle();
  expect(idle.size).toBe(0);
}

it('prepares row and grid faces in bounded idle units at the actual zoom', async () => {
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  warmPaneFontMetrics(source(), 'Arial, "Yu Gothic", sans-serif', 0.75);
  await Promise.resolve();
  runIdle();
  expect(measured).toHaveLength(1);
  expect(idle.size).toBe(1);
  drain();
  expect([...new Set(measured.map((item) => item.font))]).toEqual(
    expect.arrayContaining([
      '700 9px Arial, "Yu Gothic", sans-serif',
      '400 9px Arial, "Yu Gothic", sans-serif',
      'italic 400 9px Arial, "Yu Gothic", sans-serif',
      'italic 700 9px Arial, "Yu Gothic", sans-serif',
      'italic 400 7px Arial, "Yu Gothic", sans-serif',
      '400 10px Arial, "Yu Gothic", sans-serif',
      '400 11px Arial, "Yu Gothic", sans-serif',
    ]),
  );
  const text = measured.map((item) => item.text).join('');
  expect(text).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  expect(text).not.toContain('ツ');
  expect(text).not.toContain('🛸');
});

it('gives input and an exhausted idle deadline priority over metric work', async () => {
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  const cancel = warmPaneFontMetrics(source(), 'Arial', 1);
  await Promise.resolve();
  pending = true;
  runIdle();
  expect(measured).toHaveLength(0);
  pending = false;
  runIdle(0);
  expect(measured).toHaveLength(0);
  runIdle();
  expect(measured).toHaveLength(1);
  cancel();
  expect(idle.size).toBe(0);
});

it('cancels before the first idle task and never reschedules an unmounted pane', async () => {
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  const cancel = warmPaneFontMetrics(source(), 'Arial', 1);
  cancel();
  await Promise.resolve();
  expect(idle.size).toBe(0);
  expect(measured).toHaveLength(0);
});

it('starts before source arrival and extends completed preparation with new source styles', async () => {
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  warmPaneFontMetrics(null, 'Arial', 1);
  await Promise.resolve();
  drain();
  const initial = new Set(measured.map((item) => item.font));
  expect(initial.size).toBeGreaterThan(0);
  measured = [];
  warmPaneFontMetrics(source(), 'Arial', 1);
  await Promise.resolve();
  drain();
  const additional = new Set(measured.map((item) => item.font));
  expect(additional).toEqual(new Set(['400 14.666666666666666px Arial']));
  expect(initial.has('400 14.666666666666666px Arial')).toBe(false);
});

it('reuses completed preparation but prepares a new source revision or zoom', async () => {
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  const revision = source();
  warmPaneFontMetrics(revision, 'Arial', 1);
  await Promise.resolve();
  drain();
  warmPaneFontMetrics(revision, 'Arial', 1);
  await Promise.resolve();
  expect(idle.size).toBe(0);
  const next = warmPaneFontMetrics(source(), 'Arial', 1);
  await Promise.resolve();
  expect(idle.size).toBe(1);
  next();
  const zoom = warmPaneFontMetrics(revision, 'Arial', 0.8);
  await Promise.resolve();
  expect(idle.size).toBe(1);
  zoom();
});

it('does not read dirty sheet styles again when source data or zoom changes', async () => {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePaneFontMetrics } = await import('./paneFontMetrics');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const body = document.createElement('div');
  body.innerHTML = '<div data-scale="100"></div>';
  const bodyRef = { current: body };
  const style = vi
    .spyOn(window, 'getComputedStyle')
    .mockReturnValue({ fontFamily: 'Arial' } as CSSStyleDeclaration);
  function Pane({ data, scale }: { data: CompendiumData | null; scale: number }) {
    usePaneFontMetrics(bodyRef, data, scale);
    return null;
  }
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Pane, { data: null, scale: 100 })));
    expect(style).toHaveBeenCalledTimes(1);
    const revision = source();
    await act(async () => root.render(createElement(Pane, { data: revision, scale: 100 })));
    await act(async () => root.render(createElement(Pane, { data: revision, scale: 80 })));
    expect(style).toHaveBeenCalledTimes(1);
    body.innerHTML = '<div data-scale="80"></div>';
    await act(async () => root.render(createElement(Pane, { data: source(), scale: 80 })));
    expect(style).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
