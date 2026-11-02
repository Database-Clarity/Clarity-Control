// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranslationSource } from './TranslationSource';

vi.mock('../translations/EnglishDiff', () => ({
  EnglishDiffContent: () => createElement('div', null, 'Diff content'),
}));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => vi.unstubAllGlobals());
it('switches views and remembers the choice on remount, with no toggle for current translations', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const props = {
    text: 'Current source',
    diff: { hash: 10, sourceUpdatedAt: 'old', current: 'Current source' },
  };
  await act(async () => root.render(createElement(TranslationSource, props)));
  const toggle = host.querySelector('button')!;
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(host.textContent).toContain('Diff content');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(host.textContent).toContain('Current source');
  expect(host.textContent).not.toContain('Diff content');
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(TranslationSource, props)));
  expect(host.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('Diff content');
  await act(async () => root.render(createElement(TranslationSource, { text: 'Current source' })));
  expect(host.querySelector('button')).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
