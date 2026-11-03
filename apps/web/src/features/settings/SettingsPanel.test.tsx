// @vitest-environment jsdom
import { act, createElement, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSyncedSettings } from '@clarity/core';
import { fakeServer } from '../../stores/settings.testSupport';
import { layoutKey, settingsKey, useSettingsStore } from '../../stores/settings';
import { CommitAuthor } from '../history/CommitAuthor';
import { useSettingsNotices } from './SettingsChoice';
import { NoticeStrip } from '../navigation/NoticeStrip';
import { RememberRoute, SettingsRedirect } from './SettingsRedirect';
import { SettingsPopover } from './SettingsPopover';
import { useSettingsPanel } from './panel';
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
  useSettingsPanel.setState({ open: false, returnTo: '/' });
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

function Where() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="path">{pathname}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}
/** What the layout shows outside Settings: the sync notices, as overlay strips. */
function SettingsNotice() {
  return <NoticeStrip notices={useSettingsNotices()} />;
}

/** The layout's settings wiring: sync, route memory, the Settings button, the popover. */
function Shell({ children }: { children?: ReactNode }) {
  const layout = useRef<HTMLDivElement>(null);
  const open = useSettingsPanel((state) => state.open);
  return (
    <>
      <div ref={layout} data-testid="layout">
        <SettingsSync />
        <RememberRoute />
        <Where />
        <Link to="/settings">Settings link</Link>
        <button
          type="button"
          className="settings-link"
          onClick={() => useSettingsPanel.getState().show()}
        >
          Settings
        </button>
        <Routes>
          <Route path="settings" element={<SettingsRedirect />} />
          <Route path="*" element={<p>Page content</p>} />
        </Routes>
        {children}
        {!open && <SettingsNotice />}
      </div>
      <SettingsPopover layout={layout} />
    </>
  );
}
async function render(node: ReactNode = null, entries = ['/archive']) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={entries}>
        <Shell>{node}</Shell>
      </MemoryRouter>,
    ),
  );
}
const field = (label: string) =>
  [...document.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith(label))!
    .querySelector('select')!;
const scaleInput = () =>
  [...document.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith('Interface scale'))!
    .querySelector('input')!;
async function setScale(value: number) {
  const input = scaleInput();
  await act(async () => {
    // React tracks the value property; the native setter makes the change visible to it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      String(value),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const select = field(label);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent?.includes(text))!;
const popover = () => document.querySelector<HTMLElement>('[role="dialog"]');
const path = () => document.querySelector('[data-testid="path"]')!.textContent;
const layoutInert = () => document.querySelector('[data-testid="layout"]')!.hasAttribute('inert');
async function openSettings() {
  const opener = button('Settings');
  opener.focus();
  await act(async () => opener.click());
}
const closeButton = () =>
  document.querySelector<HTMLElement>('button[aria-label="Close settings"]')!;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });

describe('Settings popover', () => {
  it('applies changes live behind the popover and does not sync while open', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render(
      <CommitAuthor
        entry={{
          commit: 'a'.repeat(40),
          author: 'alice',
          login: null,
          avatar: null,
          date: '2023-02-12T20:12:00Z',
          message: 'x',
        }}
      />,
    );
    await openSettings();
    expect(popover()).not.toBeNull();
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
    expect(document.body.textContent).toContain('Syncs to your account when you leave Settings');
    expect(holder.server.calls.put).toHaveLength(0);
  });

  it.each([
    ['the Close button', () => act(async () => closeButton().click())],
    ['Escape', () => press('Escape')],
    [
      'a click outside',
      () =>
        act(async () => {
          document
            .querySelector('[data-testid="settings-backdrop"]')!
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        }),
    ],
  ])('closing with %s syncs once and returns focus to the button', async (_name, close) => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render();
    await openSettings();
    await choose('Markup toolbar', 'open');
    await choose('English source shows', 'current');
    expect(holder.server.calls.put).toHaveLength(0);
    // Choosing a default here also applies it to this device's remembered toggles.
    expect(useSettingsStore.getState().device.remembered).toEqual({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    expect(document.body.textContent).toContain(
      'Starting values for new devices (synced to your account). Toggling the toolbar or source view inside the editor is remembered on this device only. Choosing here also applies on this device.',
    );
    await close();
    expect(popover()).toBeNull();
    expect(holder.server.calls.put).toHaveLength(1);
    expect(holder.server.remote.settings).toMatchObject({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    expect(useSettingsStore.getState().status).toBe('synced');
    expect(document.activeElement).toBe(button('Settings'));
    expect(layoutInert()).toBe(false);
  });

  it('moves focus in, traps Tab and Shift+Tab, and keeps the page behind inert', async () => {
    await render();
    await openSettings();
    const dialog = popover()!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(layoutInert()).toBe(true);
    const items = [...dialog.querySelectorAll<HTMLElement>('button, select')];
    items.at(-1)!.focus();
    await press('Tab');
    expect(document.activeElement).toBe(items[0]);
    await press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('keeps device settings local and applies the interface scale immediately', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    localStorage.setItem(layoutKey, '70');
    await render();
    await openSettings();
    await setScale(125);
    expect(document.documentElement.style.fontSize).toBe('125%');
    expect(document.documentElement.dataset.uiScale).toBe('125');
    expect(useSettingsStore.getState().device.uiScale).toBe(125);
    useSettingsStore
      .getState()
      .updateDevice({ panes: { 'editor:left': { width: 400, collapsed: false } } });
    await act(async () => button('Reset pane widths').click());
    expect(localStorage.getItem(layoutKey)).toBeNull();
    expect(useSettingsStore.getState().device.panes).toEqual({});
    expect(popover()!.textContent).toContain('Pane widths reset to their defaults.');
    await act(async () => closeButton().click());
    expect(holder.server.calls.put).toHaveLength(0);
    await openSettings();
    await act(async () => button('100%').click());
    expect(document.documentElement.style.fontSize).toBe('');
    expect(scaleInput().value).toBe('100');
  });

  it('applies the editor font immediately and keeps it local on close', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render();
    await openSettings();
    expect(field('Editor font').value).toBe('default');
    await choose('Editor font', 'fira-code');
    expect(document.documentElement.dataset.editorFont).toBe('fira-code');
    await act(async () => closeButton().click());
    expect(holder.server.calls.put).toHaveLength(0);
    await openSettings();
    expect(field('Editor font').value).toBe('fira-code');
    await choose('Editor font', 'default');
  });

  it('opens on /settings over the page it came from and replaces the URL', async () => {
    await render(null, ['/', '/archive']);
    await act(async () =>
      document.querySelector<HTMLAnchorElement>('a[href="/settings"]')!.click(),
    );
    expect(path()).toBe('/archive');
    expect(popover()).not.toBeNull();
    await act(async () => closeButton().click());
    expect(popover()).toBeNull();
    // Back leaves the replaced entry; it never lands on (or reopens) /settings.
    await act(async () => button('Back').click());
    expect(path()).not.toBe('/settings');
    expect(popover()).toBeNull();
  });

  it('opens a direct /settings visit over home', async () => {
    await render(null, ['/settings']);
    expect(path()).toBe('/');
    expect(popover()).not.toBeNull();
  });

  it('becomes a full-screen sheet with a clear Close button on phones', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('700px') }));
    await render();
    await openSettings();
    const dialog = popover()!;
    // No anchoring on phones: the stylesheet makes it fill the screen.
    expect(dialog.getAttribute('style')).toBeNull();
    expect(closeButton().textContent).toBe('Close');
    await act(async () => closeButton().click());
    expect(popover()).toBeNull();
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
    await render();
    // Outside Settings only a notice shows; the choice itself is made inside Settings.
    expect(host.textContent).toContain('Settings changed on this device were not synced');
    expect(host.querySelector('td')).toBeNull();
    await act(async () => button('Review in Settings').click());
    expect(document.body.textContent).toContain('Unsynced settings changes');
    expect(host.textContent).not.toContain('Review in Settings');
    // Each value cell names its column, so the rows still read when stacked on phones.
    expect(
      [...document.querySelectorAll('td')].map((cell) => cell.getAttribute('data-label')),
    ).toEqual(['This device', 'Synced copy']);
    expect(document.body.textContent).toContain('YYYY-MM-DD (2023-02-12)');
    expect(document.body.textContent).toContain('MM/DD/YYYY (02/12/2023)');
    expect(holder.server.calls.put).toHaveLength(0);
    await act(async () => button('Use synced settings').click());
    expect(useSettingsStore.getState().settings.dateFormat).toBe('mdy');
    expect(document.body.textContent).not.toContain('Unsynced settings changes');
    expect(holder.server.calls.put).toHaveLength(0);
  });

  it('shows both copies when another device synced first, and keeps this one on request', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render();
    await openSettings();
    await choose('Time zone', 'Asia/Tokyo');
    holder.server.set({ ...defaultSyncedSettings, timeZone: 'Europe/Berlin' });
    await act(async () => closeButton().click());
    expect(host.textContent).toContain('Settings changed on another device');
    expect(host.textContent).not.toContain('Europe/Berlin');
    await act(async () => button('Review in Settings').click());
    expect(document.body.textContent).toContain('Settings changed on another device');
    expect(document.body.textContent).toContain('Asia/Tokyo');
    expect(document.body.textContent).toContain('Europe/Berlin');
    expect(holder.server.remote.settings?.timeZone).toBe('Europe/Berlin');
    await act(async () => button("Keep this device's settings").click());
    expect(holder.server.remote.settings?.timeZone).toBe('Asia/Tokyo');
    expect(useSettingsStore.getState().status).toBe('synced');
  });

  it('shows a not-synced notice with a retry after a failed close sync', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render();
    await openSettings();
    await choose('Date format', 'iso');
    holder.server.fail('server answered HTTP 503');
    await act(async () => closeButton().click());
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
    const toolbar = () => (
      <MarkupToolbar editor={{ current: null }} globals={{} as MarkupGlobals} />
    );
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

  it('ignores tab switches while open, and shows the global notice when a queued close fails', async () => {
    await act(async () => useSettingsStore.getState().activate(editor));
    await render();
    await openSettings();
    await choose('Date format', 'iso');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    Reflect.deleteProperty(document, 'visibilityState');
    expect(holder.server.calls.put).toHaveLength(0);
    holder.server.hold();
    await act(async () => closeButton().click()); // first PUT is held
    await openSettings();
    await choose('Time display', 'date');
    await act(async () => closeButton().click()); // close again while the first PUT is out: queued
    expect(holder.server.calls.put).toHaveLength(1);
    holder.server.fail('server answered HTTP 503');
    await act(async () => holder.server.release());
    expect(holder.server.calls.put).toHaveLength(2);
    expect(host.textContent).toContain('Settings not synced: server answered HTTP 503');
    holder.server.fail('');
    await act(async () => button('Retry sync').click());
    expect(holder.server.remote.settings).toMatchObject({ dateFormat: 'iso', timeDisplay: 'date' });
    expect(host.textContent).not.toContain('Settings not synced');
  });

  it('works signed out, saving on this device only', async () => {
    await render();
    await openSettings();
    expect(document.body.textContent).toContain('Sign in to sync');
    await choose('Date format', 'iso');
    expect(JSON.parse(localStorage.getItem(settingsKey('anonymous'))!).settings.dateFormat).toBe(
      'iso',
    );
    for (const select of document.querySelectorAll('select')) expect(select.disabled).toBe(false);
    expect(holder.server.calls).toEqual({ get: 0, put: [] });
  });
});
