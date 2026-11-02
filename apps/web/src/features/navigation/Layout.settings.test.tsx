// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsPanel } from '../settings/panel';

vi.hoisted(() => {
  // Node's own (flag-gated) localStorage shadows jsdom's; the settings store reads it at import.
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
    },
  });
});
vi.mock('../../services/save/SavePanel', () => ({ SavePanel: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataStore.setState({
    status: 'ready',
    data: {
      categories: [],
      items: {},
      aliases: {},
      bundle: {
        sourceCommit: 'fixture0',
        generatedAt: '2026-10-27T00:00:00Z',
        tooltips: {},
        permissions: { users: {} },
        pushed: {},
      },
    } as unknown as EditorData,
    load: async () => {},
  });
  useAuthStore.setState({ user: null, loading: false, load: async () => {} });
  useDraftStore.setState({ hydrated: true, drafts: {}, hydrate: async () => {} });
  useSettingsPanel.setState({ open: false, returnTo: '/' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('keeps keyboard traversal inside the settings sheet opened from the phone Browse drawer', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/archive']}>
        <Layout />
      </MemoryRouter>,
    ),
  );
  const click = (element: Element) => act(async () => (element as HTMLElement).click());
  await click(host.querySelector('button[aria-controls="sidebar"]')!);
  expect(host.querySelector('#sidebar')?.getAttribute('data-open')).toBe('true');
  await click(host.querySelector('button.settings-link')!);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]')!;
  const items = [...dialog.querySelectorAll<HTMLElement>('button, select')];
  items.at(-1)!.focus();
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(items[0]);
  expect(dialog.contains(document.activeElement)).toBe(true);
  // Escape closes only the settings sheet, not the Browse drawer behind it.
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  expect(document.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
  expect(host.querySelector('#sidebar')?.getAttribute('data-open')).toBe('true');
});
