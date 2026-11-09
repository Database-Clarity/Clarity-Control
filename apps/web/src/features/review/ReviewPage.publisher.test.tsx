// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import { Layout } from '../navigation/Layout';
import { ReviewPage } from './ReviewPage';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { loadGenerator } from '../../services/generator';
import { loadBundle, type Bundle } from '../../services/bundle';
import { useReviewSession } from './session';
import { publishDriver } from './publisher';
import { publishTiming } from './publishDriver';

vi.mock('../../services/generator', () => ({ loadGenerator: vi.fn() }));
vi.mock('../../services/bundle', () => ({ loadBundle: vi.fn() }));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://synthetic.invalid',
  loginUrl: () => 'https://synthetic.invalid/auth/login',
  apiRequest: (path: string, init: RequestInit) => fetch(`https://synthetic.invalid${path}`, init),
}));
vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));
vi.mock('../compendium/CompendiumBadge', () => ({
  CompendiumBadge: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));

const tooltip: Tooltip = {
  hash: 10,
  text: { en: { text: 'Saved', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
};
const user = { id: 1, login: 'fixture', role: 'maintainer' as const };
let bundle: Bundle;
let root: Root;
let host: HTMLDivElement;
let calls: { path: string; method: string; body?: unknown }[];
let statusAnswer: string;
let postAnswer: () => Response;

function buttons(label: string) {
  return [...host.querySelectorAll('button')].filter(
    (b) => b.textContent === label || b.textContent?.replace(/ \(\d+\)$/, '') === label,
  );
}
function button(label: string) {
  const found = buttons(label)[0];
  if (!found) throw Error(`Missing button ${label}: ${host.textContent}`);
  return found;
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The group header's checkbox selects every publishable change in the group (no "Select page").
async function selectAll() {
  for (const box of host.querySelectorAll<HTMLInputElement>('input[data-review-group-toggle]'))
    await act(async () => box.click());
  await flush();
}
async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await flush();
    check();
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
async function mount() {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/review'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Layout) },
            createElement(Route, { path: '/review', element: createElement(ReviewPage) }),
          ),
        ),
      ),
    ),
  );
  await waitFor(() => {
    expect(useDataStore.getState().status).toBe('ready');
    expect(host.textContent).not.toContain('Comparing publishable content...');
  });
}

beforeEach(async () => {
  vi.stubEnv('VITE_PUBLISHER_ENABLED', '1');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  useReviewSession.setState({
    acknowledgments: {},
    pushing: false,
    notice: undefined,
    error: undefined,
  });
  bundle = {
    sourceCommit: 'baseline',
    generatedAt: '2026-01-01T00:00:00Z',
    tooltips: { 10: structuredClone(tooltip) },
    pushed: {},
    permissions: { users: {} },
  };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: {
      10: { hash: 10, name: 'Tooltip 10', categoryId: 'other', icon: '', inGameDescription: '' },
    } as never,
    aliases: {},
  });
  vi.mocked(loadBundle).mockImplementation(async () => structuredClone(bundle));
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useAuthStore.setState({ user, loading: false, load: async () => {} });
  useDraftStore.setState({
    hydrated: true,
    hydrate: async () => {},
    activate: async () => {},
    drafts: {},
  });
  calls = [];
  statusAnswer = 'pending';
  postAnswer = () => Response.json({ opId: 'x', status: 'pending' }, { status: 202 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('https://synthetic.invalid', '');
      if (path.startsWith('/history/'))
        return Response.json(
          path.includes('live=1') ? { tooltip: null, pushedHash: null } : { page: 1, commits: [] },
        );
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (path === '/publish') return postAnswer();
      if (path.startsWith('/publish/status')) {
        const opId = new URL(url).searchParams.get('opId');
        return Response.json({ operations: [{ opId, status: statusAnswer }] });
      }
      if (path === '/publish/kick') return Response.json({ status: 'pending' }, { status: 202 });
      throw Error(`Blocked network: ${url}`);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await publishDriver.start('1');
});
afterEach(async () => {
  publishDriver.stop();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const posts = () => calls.filter((c) => c.path === '/publish');

it('confirms, stores and sends one operation, then follows it from Publishing to Published', async () => {
  await mount();
  expect(host.textContent).toContain('1 change · 0 selected');
  await selectAll();
  await click('Publish selected');
  const dialog = host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('Publish to live');
  expect(dialog.textContent).toContain('1 tooltip goes live for everyone using Clarity.');
  expect(dialog.textContent).toContain('Tooltip 10');
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = posts()[0]!.body as { opId: string; hashes: number[]; expected: object };
  expect(Object.keys(body).sort()).toEqual(['expected', 'hashes', 'opId']);
  expect(body.hashes).toEqual([10]);
  expect(body.expected).toEqual({ 10: await publishableHash(tooltip) });
  // The legacy path is never used with the flag on.
  expect(calls.some((c) => c.path === '/push-live')).toBe(false);
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Publishing…');
    expect(activity.textContent).toContain('1 tooltip');
  });
  // Still pending in the list, but cannot be picked again.
  expect(host.textContent).toContain('1 change · 0 selected');
  expect(host.textContent).toContain('publishing…');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  // The Worker finishes: the next status poll turns it into Published and clears the pending count.
  statusAnswer = 'done';
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Published');
    expect(host.textContent).toContain('0 changes · 0 selected');
  });
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(useReviewSession.getState().acknowledgments[10]).toEqual({
    digest: await publishableHash(tooltip),
    previous: undefined,
  });
  await click('Dismiss');
  await waitFor(() => expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull());
});

it('shows stale and failed outcomes and leaves the tooltips pending', async () => {
  await mount();
  await selectAll();
  await click('Publish selected');
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  statusAnswer = 'stale';
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Changed');
    expect(activity.textContent).toContain('Nothing from this request went live');
  });
  expect(host.textContent).toContain('1 change · 0 selected');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('keeps the operation and offers Retry once it has waited three minutes', async () => {
  await mount();
  await selectAll();
  await click('Publish selected');
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(buttons('Retry')).toHaveLength(0);
  vi.setSystemTime(Date.now() + publishTiming.waitingMs + 5_000);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    expect(host.querySelector('[aria-label="Publish activity"]')!.textContent).toContain('Waiting');
    expect(buttons('Retry')).toHaveLength(1);
  });
  // The automatic kick already went out once; the button is a second, user-driven one.
  expect(calls.filter((c) => c.path === '/publish/kick')).toHaveLength(1);
  vi.setSystemTime(Date.now() + publishTiming.manualKickGapMs + 1_000);
  await click('Retry');
  await waitFor(() => expect(calls.filter((c) => c.path === '/publish/kick')).toHaveLength(2));
});

it('lists requests other editors queued from the bundle, with Retry', async () => {
  const opId = '01M6GMFKG0JPP01N49ZMR9Z9TS';
  bundle.publishQueue = [
    {
      opId,
      requester: { id: 9, login: 'other' },
      hashes: [10],
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
  ];
  await mount();
  const activity = host.querySelector('[aria-label="Publish activity"]')!;
  expect(activity.textContent).toContain('1 publish request waiting');
  await click('Retry');
  await waitFor(() =>
    expect(calls.find((c) => c.path === '/publish/kick')?.body).toEqual({ opId }),
  );
});

it('rebuilds the in-flight state from storage after a reload and never mints a second opId', async () => {
  postAnswer = () => new Response('offline', { status: 503 });
  await mount();
  await selectAll();
  await click('Publish selected');
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  const first = (posts()[0]!.body as { opId: string }).opId;
  // "Reload": new page load, same storage.
  publishDriver.stop();
  await act(async () => root.unmount());
  root = createRoot(host);
  postAnswer = () => Response.json({ opId: first, status: 'pending' }, { status: 202 });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  await publishDriver.start('1');
  await mount();
  await waitFor(() => expect(posts().length).toBeGreaterThanOrEqual(2));
  expect(new Set(posts().map((c) => (c.body as { opId: string }).opId))).toEqual(new Set([first]));
  expect(host.querySelector('[aria-label="Publish activity"]')!.textContent).toContain(
    'Publishing…',
  );
});

it('shows no publish controls or activity to accounts that cannot publish', async () => {
  useAuthStore.setState({ user: { ...user, role: 'trial' } });
  await mount();
  expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull();
  expect(buttons('Publish selected')).toHaveLength(0);
  expect(buttons('Push selected')).toHaveLength(0);
});

it('flag off: the legacy push path and wording are unchanged and nothing is stored or polled', async () => {
  vi.stubEnv('VITE_PUBLISHER_ENABLED', '');
  await mount();
  await selectAll();
  expect(buttons('Publish selected')).toHaveLength(0);
  await click('Push selected');
  expect(host.querySelector('dialog')!.textContent).toContain('Push to live');
  expect(buttons('Push 1 live')).toHaveLength(1);
  expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull();
  expect(calls.filter((c) => c.path.startsWith('/publish'))).toEqual([]);
});
