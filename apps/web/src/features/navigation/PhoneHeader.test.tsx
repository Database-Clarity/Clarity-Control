// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsPanel } from '../settings/panel';
import { PhoneHeader } from './PhoneHeader';

vi.mock('../compendium/CompendiumBadge', async (original) => ({
  ...(await original<typeof import('../compendium/CompendiumBadge')>()),
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
  loginUrl: () => 'https://api.test/login',
  subscribeSession: () => () => {},
}));

const data = {
  categories: [],
  items: {},
  aliases: {},
  bundle: { sourceCommit: 'abcdef123456', tooltips: {}, permissions: { users: {} }, pushed: {} },
} as unknown as EditorData;
const person = (role: User['role']) =>
  ({ id: 7, login: 'pat', role, languages: ['de'] }) as unknown as User;

let host: HTMLDivElement;
let root: Root;
const originalAuth = useAuthStore.getState();
const originalData = useDataStore.getState();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A phone: the shell's sheets.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 700px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
  useDraftStore.setState({ drafts: {}, hydrated: true, error: null });
  useSettingsPanel.setState({ open: false, opener: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState(originalAuth);
  useDataStore.setState(originalData);
  useSettingsPanel.setState({ open: false, opener: null });
  vi.unstubAllGlobals();
});

async function mount(user: User | null, state: { error?: string | null } = {}) {
  useAuthStore.setState({ user, loading: false, error: state.error ?? null, load: async () => {} });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <PhoneHeader
          user={user}
          pathname="/"
          routeFor={(to) => to}
          title="Editor"
          finder={null}
          hasFinder={false}
        />
      </MemoryRouter>,
    ),
  );
}
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const mark = () => q<HTMLButtonElement>('header > button');
const click = (element: Element) => act(async () => void (element as HTMLElement).click());
async function key(target: Element, name: string) {
  await act(
    async () =>
      void target.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      ),
  );
}
const rows = () =>
  [...document.querySelectorAll('[role="group"][aria-label="Settings and account"] button')].map(
    (row) => row.textContent,
  );

describe('phone header', () => {
  it('holds the mark, the title, and Drafts only: Settings and the account are in the menu', async () => {
    await mount(person('maintainer'));
    expect(document.querySelector('header [data-settings-button]')).toBeNull();
    expect(document.querySelector('header [data-identity-button]')).toBeNull();
    expect(q('header [data-drafts-button]')).not.toBeNull();
    await click(mark());
    expect(rows()).toEqual(['Settings', 'Ppatmaintainer']);
  });

  it('opens Settings from the menu; Settings returns focus to the mark', async () => {
    await mount(person('maintainer'));
    await click(mark());
    const settings = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Settings',
    )!;
    await click(settings);
    expect(useSettingsPanel.getState().open).toBe(true);
    // The opener is where Settings sends focus back when it closes.
    expect(useSettingsPanel.getState().opener).toBe(mark());
    expect(document.querySelector('[data-shell-overlay]')).toBeNull();
  });

  it('opens the Account sheet from the menu; Escape closes it and focus returns to the mark', async () => {
    await mount(person('maintainer'));
    await click(mark());
    await click(q('[data-identity-row]'));
    expect(q('[data-shell-overlay]').getAttribute('data-shell-overlay')).toBe('Account');
    expect(q('[data-shell-overlay]').textContent).toContain('Sign out');
    await key(document.activeElement!, 'Escape');
    expect(document.querySelector('[data-shell-overlay]')).toBeNull();
    expect(document.activeElement).toBe(mark());
  });

  it('Back closes an open overlay (the route still moves)', async () => {
    await mount(person('maintainer'));
    await click(mark());
    expect(document.querySelector('[data-shell-overlay]')).not.toBeNull();
    await act(async () => void window.dispatchEvent(new PopStateEvent('popstate')));
    expect(document.querySelector('[data-shell-overlay]')).toBeNull();
  });

  it('signed out: Sign in sits in the menu and leads to the GitHub sign-in', async () => {
    await mount(null);
    expect(document.querySelector('header a[href="https://api.test/login"]')).toBeNull();
    await click(mark());
    expect(rows()).toEqual(['Settings', 'Sign in']);
    await click(q('[data-identity-row]'));
    expect(q<HTMLAnchorElement>('[data-shell-overlay] a').href).toBe('https://api.test/login');
  });

  it('puts a danger dot on the mark for a login problem, with the message on the account row', async () => {
    await mount(null, { error: 'down' });
    expect(mark().getAttribute('aria-label')).toContain('account problem');
    await click(mark());
    expect(q('[data-identity-row]').textContent).toContain('Login unavailable');
  });
});

it('names an opened global declaration in the phone header', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/t/2?global=CombatantScaling']}>
        <PhoneHeader
          user={null}
          pathname="/t/2"
          routeFor={(to) => to}
          title="Global variables"
          finder={null}
          hasFinder
        />
      </MemoryRouter>,
    ),
  );
  expect(host.querySelector('[data-tooltip-finder]')?.textContent).toContain('CombatantScaling');
});
