// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranslationSource } from './TranslationSource';
import { useSettingsStore } from '../../stores/settings';

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
const select = (host: HTMLElement) =>
  host.querySelector<HTMLSelectElement>('select[aria-label="English shows"]');
const choose = async (element: HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });

it('shows English in a headed pane; "Shows" is remembered on this device, starting from the Settings default, and absent for current translations', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const props = {
    text: 'Current source',
    diff: { hash: 10, sourceUpdatedAt: 'old', current: 'Current source' },
  };
  await act(async () => root.render(createElement(TranslationSource, props)));
  expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('English source');
  expect(host.querySelector('h3')?.textContent).toBe('English');
  expect(select(host)!.value).toBe('changes');
  expect(host.textContent).toContain('Diff content');
  await choose(select(host)!, 'current');
  expect(select(host)!.value).toBe('current');
  expect(host.textContent).toContain('Current source');
  expect(host.textContent).not.toContain('Diff content');
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(TranslationSource, props)));
  // Remembered on this device, but never a synced change (no pending marker, no prompt).
  expect(select(host)!.value).toBe('current');
  const state = useSettingsStore.getState();
  expect(state.device.remembered.englishSource).toBe('current');
  expect(state.settings.englishSource).toBe('changes');
  expect(state.pending).toEqual([]);
  await choose(select(host)!, 'changes');
  expect(host.textContent).toContain('Diff content');
  await act(async () => root.render(createElement(TranslationSource, { text: 'Current source' })));
  expect(select(host)).toBeNull();
  expect(host.textContent).toContain('Current source');
  await act(async () => root.unmount());
  host.remove();
});

it('says so when the English has no text yet', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(TranslationSource, { text: undefined })));
  expect(host.textContent).toContain('This tooltip has no English text yet.');
  await act(async () => root.unmount());
  host.remove();
});

it('keeps the English source as raw markup: the editor tints and symbols never reach it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const text = 'Deal <yellow 5 <arc/> /> <pve 3 />';
  await act(async () => root.render(createElement(TranslationSource, { text })));
  expect(host.querySelector('pre')?.textContent).toBe(text);
  expect(host.querySelector('.cm-tint, .cm-symbol')).toBeNull();
  await act(async () => root.unmount());
});
