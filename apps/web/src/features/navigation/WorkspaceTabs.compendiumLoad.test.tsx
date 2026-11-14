// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useCompendiumStore } from '../compendium/store';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';
import { useDataStore, type EditorData } from '../../stores/data';

vi.mock('../reports/pane/ReportsEntry', () => ({
  ReportsEntry: () => null,
  ReportsMenuRow: () => null,
}));

const original = {
  compendium: useCompendiumStore.getState(),
  auth: useAuthStore.getState(),
  data: useDataStore.getState(),
};
const load = vi.fn<(force?: boolean) => Promise<void>>(async () => {});
let host: HTMLDivElement;
let root: Root;
const user = (role: 'translator' | 'editor') =>
  ({ id: 1, login: 'qa', role, languages: ['de'] }) as User;
async function mount() {
  const signedIn = useAuthStore.getState().user;
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(WorkspaceTabs, { user: signedIn, pathname: '/', routeFor: (to) => to }),
      ),
    ),
  );
  await act(async () => vi.runAllTimers());
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  load.mockClear();
  useCompendiumStore.setState({ data: null, load });
  const data = { bundle: { tooltips: {} }, items: {}, aliases: {} } as unknown as EditorData;
  useDataStore.setState({ data, status: 'ready' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
  useCompendiumStore.setState(original.compendium);
  useAuthStore.setState(original.auth);
  useDataStore.setState(original.data);
});

describe('the header loads the live Compendium sheet', () => {
  it('not while sign-in is unresolved, then never for a translator', async () => {
    useAuthStore.setState({ user: null, loading: true });
    await mount();
    expect(load).not.toHaveBeenCalled();
    useAuthStore.setState({ user: user('translator'), loading: false });
    await mount();
    expect(load).not.toHaveBeenCalled();
  });

  it('once sign-in settles as an editor', async () => {
    useAuthStore.setState({ user: null, loading: true });
    await mount();
    useAuthStore.setState({ user: user('editor'), loading: false });
    await mount();
    expect(load).toHaveBeenCalled();
  });

  it('once sign-in settles signed out, as before', async () => {
    useAuthStore.setState({ user: null, loading: true });
    await mount();
    expect(load).not.toHaveBeenCalled();
    useAuthStore.setState({ user: null, loading: false });
    await mount();
    expect(load).toHaveBeenCalled();
  });
});
