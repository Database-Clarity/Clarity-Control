// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings } from '@clarity/core';
import { fakeServer } from '../../stores/settings.testSupport';
import { layoutKey, settingsKey, useSettingsStore } from '../../stores/settings';
import { CommitAuthor } from '../history/CommitAuthor';
import { SettingsNotice } from './SettingsChoice';
import { SettingsPage } from './SettingsPage';
import { SettingsSync } from './SettingsSync';
import { MarkupToolbar } from '../editor/MarkupToolbar';
import type { MarkupGlobals } from '@clarity/core';

const holder = vi.hoisted(() => {
  // Node's own (flag-gated) localStorage shadows jsdom's; install a real one before the
  // settings store module reads it at import time.
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
  return { server: null as unknown as ReturnType<typeof fakeServer> };
});
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
  getSettings: () => holder.server.api.get(),
  putSettings: (...args: Parameters<ReturnType<typeof fakeServer>['api']['put']>) =>
    holder.server.api.put(...args),
}));

const editor = { id: 42, role: 'translator' };
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  holder.server = fakeServer();
  await useSettingsStore.getState().activate(null);
  useSettingsStore.getState().update(defaultSyncedSettings);
  useSettingsStore.getState().updateDevice({ remembered: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode, path = '/settings') {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: 'settings', element: node }),
          createElement(Route, { path: '/', element: createElement('p', null, 'Editor home') }),
        ),
      ),
    ),
  );
}
const field = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith(label))!
    .querySelector('select')!;
async function choose(label: string, value: string) {
  const select = field(label);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((element) => element.textContent?.includes(text))!;

describe('Settings page', () => {
  it('applies changes live without a remount and does not sync while still on the page', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(
      createElement(
        'div',
        null,
        createElement(SettingsPage),
        createElement(CommitAuthor, {
          entry: {
            commit: 'a'.repeat(40),
            author: 'alice',
            login: null,
            avatar: null,
            date: '2023-02-12T20:12:00Z',
            message: 'x',
          },
        }),
      ),
    );
    await choose('Time zone', 'UTC');
    await choose('Date format', 'iso');
    const time = host.querySelector('time')!;
    expect(time.textContent).toBe('2023-02-12 20:12 UTC');
    expect(time.getAttribute('dateTime')).toBe('2023-02-12T20:12:00Z');
    await choose('Date format', 'dmy');
    expect(host.querySelector('time')).toBe(time);
    expect(time.textContent).toBe('12 Feb 2023, 20:12 UTC');
    await choose('Time display', 'relative');
    expect(time.textContent).toMatch(/ago$/);
    expect(time.title).toContain('12 Feb 2023, 20:12 UTC');
    expect(host.textContent).toContain('Syncs to your account when you leave Settings');
    expect(holder.server.calls.put).toHaveLength(0);
  });

  it('syncs when the user leaves the page', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(createElement(SettingsPage));
    await choose('Markup toolbar', 'open');
    await choose('English source shows', 'current');
    expect(holder.server.calls.put).toHaveLength(0);
    // Choosing a default here also applies it to this device's remembered toggles.
    expect(useSettingsStore.getState().device.remembered).toEqual({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    expect(host.textContent).toContain(
      'Starting values for new devices (synced to your account). Toggling the toolbar or source view inside the editor is remembered on this device only. Choosing here also applies on this device.',
    );
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/"]')!.click());
    expect(host.textContent).toContain('Editor home');
    expect(holder.server.calls.put).toHaveLength(1);
    expect(holder.server.remote.settings).toMatchObject({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    expect(useSettingsStore.getState().status).toBe('synced');
  });

  it('keeps device settings local and applies large text immediately', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    localStorage.setItem(layoutKey, '70');
    await render(createElement(SettingsPage));
    await choose('Text size', 'large');
    expect(document.documentElement.dataset.textSize).toBe('large');
    await act(async () => button('Reset editor layout').click());
    expect(localStorage.getItem(layoutKey)).toBeNull();
    await act(async () => root.render(createElement('p', null, 'left')));
    expect(holder.server.calls.put).toHaveLength(0);
    await render(createElement(SettingsPage));
    await choose('Text size', 'default');
    expect(document.documentElement.dataset.textSize).toBeUndefined();
  });

  it('prompts after a reload with unsynced changes and can discard them', async () => {
    holder.server.set({ ...defaultSyncedSettings, dateFormat: 'mdy' });
    // What a closed tab leaves behind: a local copy with a pending marker.
    localStorage.setItem(
      settingsKey('42'),
      JSON.stringify({
        settings: { ...defaultSyncedSettings, dateFormat: 'iso' },
        revision: null,
        pending: ['dateFormat'],
        pendingSince: '2026-11-01T09:00:00Z',
      }),
    );
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(createElement(SettingsNotice));
    expect(host.textContent).toContain('Unsynced settings changes');
    // Each value cell names its column, so the rows still read when stacked on phones.
    expect([...host.querySelectorAll('td')].map((cell) => cell.getAttribute('data-label'))).toEqual(
      ['This device', 'Synced copy'],
    );
    expect(host.textContent).toContain('YYYY-MM-DD (2023-02-12)');
    expect(host.textContent).toContain('MM/DD/YYYY (02/12/2023)');
    expect(holder.server.calls.put).toHaveLength(0);
    await act(async () => button('Use synced settings').click());
    expect(useSettingsStore.getState().settings.dateFormat).toBe('mdy');
    expect(host.textContent).toBe('');
    expect(holder.server.calls.put).toHaveLength(0);
  });

  it('shows both copies when another device synced first, and keeps this one on request', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(createElement('div', null, createElement(SettingsPage)));
    await choose('Time zone', 'Asia/Tokyo');
    holder.server.set({ ...defaultSyncedSettings, timeZone: 'Europe/Berlin' });
    await act(async () =>
      root.render(createElement(MemoryRouter, null, createElement(SettingsNotice))),
    );
    expect(host.textContent).toContain('Settings changed on another device');
    expect(host.textContent).toContain('Asia/Tokyo');
    expect(host.textContent).toContain('Europe/Berlin');
    expect(holder.server.remote.settings?.timeZone).toBe('Europe/Berlin');
    await act(async () => button("Keep this device's settings").click());
    expect(holder.server.remote.settings?.timeZone).toBe('Asia/Tokyo');
    expect(useSettingsStore.getState().status).toBe('synced');
  });

  it('shows a not-synced notice with a retry after a failed exit sync', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(createElement(SettingsPage));
    await choose('Date format', 'iso');
    holder.server.fail('server answered HTTP 503');
    await act(async () =>
      root.render(createElement(MemoryRouter, null, createElement(SettingsNotice))),
    );
    expect(host.textContent).toContain('Settings not synced: server answered HTTP 503');
    // The technical cause stays available as a tooltip, not in the sentence.
    expect(host.querySelector('[role="alert"]')?.getAttribute('title')).toBe('HTTP 503');
    holder.server.fail('');
    await act(async () => button('Retry sync').click());
    expect(useSettingsStore.getState()).toMatchObject({ status: 'synced', pending: [] });
  });

  it('remembers the markup toolbar per device without syncing or prompting', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    useSettingsStore.getState().update({ markupToolbar: 'open' });
    useSettingsStore.getState().updateDevice({ remembered: {} });
    await act(async () => useSettingsStore.getState().sync());
    const puts = holder.server.calls.put.length;
    const toolbar = () =>
      createElement(MarkupToolbar, { editor: { current: null }, globals: {} as MarkupGlobals });
    await render(toolbar());
    // No remembered click yet: the synced default applies.
    expect(button('Hide markup tools')).toBeTruthy();
    await act(async () => button('Hide markup tools').click());
    await act(async () => root.render(createElement('p')));
    await render(toolbar());
    expect(button('Show markup tools')).toBeTruthy();
    expect(useSettingsStore.getState()).toMatchObject({ pending: [], status: 'synced' });
    expect(useSettingsStore.getState().settings.markupToolbar).toBe('open');
    expect(holder.server.calls.put).toHaveLength(puts);
  });

  it('ignores tab switches while open, and shows the global notice when a queued exit fails', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    const page = () =>
      createElement('div', null, createElement(SettingsSync), createElement(SettingsPage));
    const elsewhere = () =>
      act(async () =>
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(SettingsSync),
            createElement(SettingsNotice),
          ),
        ),
      );
    await render(page());
    await choose('Date format', 'iso');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    Reflect.deleteProperty(document, 'visibilityState');
    expect(holder.server.calls.put).toHaveLength(0);
    holder.server.hold();
    await elsewhere(); // leave: first PUT is held
    await render(page());
    await choose('Time display', 'date');
    await elsewhere(); // leave again while the first PUT is out: queued
    expect(holder.server.calls.put).toHaveLength(1);
    holder.server.fail('server answered HTTP 503');
    await act(async () => holder.server.release());
    expect(holder.server.calls.put).toHaveLength(2);
    expect(host.textContent).toContain('Settings not synced: server answered HTTP 503');
    holder.server.fail('');
    await act(async () => button('Retry sync').click());
    expect(holder.server.remote.settings).toMatchObject({ dateFormat: 'iso', timeDisplay: 'date' });
    expect(host.textContent).toBe('');
  });

  it('works signed out, saving on this device only', async () => {
    await render(createElement(SettingsPage));
    expect(host.textContent).toContain('Sign in to sync');
    await choose('Date format', 'iso');
    expect(JSON.parse(localStorage.getItem(settingsKey('anonymous'))!).settings.dateFormat).toBe(
      'iso',
    );
    for (const select of host.querySelectorAll('select')) expect(select.disabled).toBe(false);
    expect(holder.server.calls).toEqual({ get: 0, put: [] });
  });
});
