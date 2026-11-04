import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';

afterEach(() => vi.unstubAllGlobals());

it('prepares all source styles once, yields to input and never mutates source content', async () => {
  vi.resetModules();
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('scheduler', {
    postTask: (callback: () => void) => {
      callbacks.push(callback);
      return Promise.resolve();
    },
  });
  let busy = true;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => busy } });
  const context = { font: '', measureText: vi.fn() };
  const fontCalls: string[] = [];
  context.measureText.mockImplementation(() => fontCalls.push(context.font));
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({ getContext: () => context })),
  });
  const { prepareCompendiumFonts } = await import('./prepareFonts');
  const { source } = guidedFixture();
  source.tabs[0].rows[0].cell.runs = [{ text: 'First', sizePt: 8, bold: true }];
  source.tabs[0].rows[1].cell.runs = [{ text: 'Other entry', sizePt: 9, italic: true }];
  const before = JSON.stringify(source);
  prepareCompendiumFonts(source);
  callbacks.shift()!();
  expect(context.measureText).not.toHaveBeenCalled();
  busy = false;
  for (let i = 0; callbacks.length && i < 10000; i++) callbacks.shift()!();
  expect(context.measureText.mock.calls.every(([text]) => text === 'Mg')).toBe(true);
  expect(context.measureText.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(fontCalls.some((font) => font.includes('normal 700 8pt'))).toBe(true);
  expect(fontCalls.some((font) => font.includes('italic 400 9pt'))).toBe(true);
  const calls = context.measureText.mock.calls.length;
  prepareCompendiumFonts(source);
  for (let i = 0; callbacks.length && i < 10000; i++) callbacks.shift()!();
  expect(context.measureText).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(source)).toBe(before);
});

it('keeps source loading independent of unavailable optional canvas support', async () => {
  vi.resetModules();
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => {
        throw new Error('Canvas is unavailable');
      },
    }),
  });
  const { prepareCompendiumFonts } = await import('./prepareFonts');
  expect(() => prepareCompendiumFonts(guidedFixture().source)).not.toThrow();
});
