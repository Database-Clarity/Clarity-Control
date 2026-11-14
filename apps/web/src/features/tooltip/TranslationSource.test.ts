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

it('renders the English source with preview tints and symbols', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const text = 'Deal <yellow 5 <arc/> /> <pve 3 />';
  await act(async () => root.render(createElement(TranslationSource, { text })));
  expect(host.querySelector('pre')).toBeNull();
  expect(host.textContent).not.toContain('<yellow');
  expect(host.textContent).toContain('Deal');
  expect(host.querySelector('[class*=yellow]')).not.toBeNull();
  expect(host.querySelector('.cm-tint, .cm-symbol')).toBeNull();
  await act(async () => root.unmount());
});

it('shows an enhanced pair as Compare by default; Base, Enhanced, and Raw are remembered on this device', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const props = {
    text: 'Handling <green 10 />',
    hash: 10,
    enhanced: { hash: 11, text: 'Handling <green 15 />' },
  };
  const versions = () => [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="English version"] button'),
  ];
  const pressed = () => versions().find((button) => button.ariaPressed === 'true')?.textContent;
  const raw = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => root.render(createElement(TranslationSource, props)));
  expect(pressed()).toBe('Compare');
  expect(host.querySelector('[data-english-compare]')).not.toBeNull();
  expect(host.textContent).toContain('10');
  expect(host.textContent).toContain('15');
  await act(async () => versions()[1]!.click());
  expect(pressed()).toBe('Enhanced');
  expect(host.querySelector('[data-english-compare]')).toBeNull();
  expect(host.textContent).toContain('15');
  expect(host.textContent).not.toContain('10');
  await act(async () => raw().click());
  expect(raw().getAttribute('aria-checked')).toBe('true');
  expect(host.querySelector('[data-english-raw]')?.textContent).toContain('<green 15 />');
  expect(versions()).toEqual([]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(TranslationSource, props)));
  expect(useSettingsStore.getState().device.remembered.englishVersion).toBe('enhanced');
  expect(host.querySelector('[data-english-raw]')).not.toBeNull();
  await act(async () => raw().click());
  expect(pressed()).toBe('Enhanced');
  // Without an enhanced version the switch stays, dimmed, on Base.
  await act(async () => root.render(createElement(TranslationSource, { text: 'Plain', hash: 12 })));
  expect(pressed()).toBe('Base');
  expect(versions()[1]!.disabled).toBe(true);
  expect(useSettingsStore.getState().pending).toEqual([]);
  await act(async () => root.unmount());
  host.remove();
});
