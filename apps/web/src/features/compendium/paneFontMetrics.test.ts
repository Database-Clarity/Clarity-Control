// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';

let clock: number;
let pending: boolean;
let serial: number;
let idle: Map<number, IdleRequestCallback>;
let measured: { font: string; text: string }[];
let fontsDescriptor: PropertyDescriptor | undefined;
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
  fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => ({ ready: Promise.resolve() }),
  });
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('navigator', {
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
  if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor);
  else Reflect.deleteProperty(document, 'fonts');
});
function runIdle(budget = 50) {
  const [id, callback] = idle.entries().next().value!;
  idle.delete(id);
  callback({ timeRemaining: () => budget, didTimeout: false });
}
function drain() {
  for (let count = 0; idle.size && count < 100; count++) runIdle();
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
  expect(new Set(measured.map((item) => item.font))).toEqual(
    new Set([
      '700 9px Arial, "Yu Gothic", sans-serif',
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

it('cancels before fonts become ready and never reschedules an unmounted pane', async () => {
  let ready!: () => void;
  vi.spyOn(document, 'fonts', 'get').mockReturnValue({
    ready: new Promise<void>((resolve) => {
      ready = resolve;
    }),
  } as unknown as FontFaceSet);
  const { warmPaneFontMetrics } = await import('./paneFontMetrics');
  const cancel = warmPaneFontMetrics(source(), 'Arial', 1);
  cancel();
  ready();
  await Promise.resolve();
  expect(idle.size).toBe(0);
  expect(measured).toHaveLength(0);
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
