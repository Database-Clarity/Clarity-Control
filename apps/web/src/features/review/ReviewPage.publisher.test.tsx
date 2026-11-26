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
import { useReviewQueue } from './queueStore';

vi.mock('../../services/generator', () => ({ loadGenerator: vi.fn() }));
vi.mock('../../services/bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/bundle')>()),
  loadBundle: vi.fn(),
}));
vi.mock('../../services/globalsFlag', async (original) => ({
  ...(await original<typeof import('../../services/globalsFlag')>()),
  globalsEnabled: true,
}));
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
  CompendiumWarmup: () => null,
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
  await waitFor(() => {
    const groups = [...host.querySelectorAll<HTMLInputElement>('input[data-review-group-toggle]')];
    expect(groups.length).toBeGreaterThan(0);
    for (const box of groups) {
      expect(box.disabled).toBe(false);
      expect(box.closest('[hidden], [aria-hidden="true"], [inert]')).toBeNull();
    }
  });
  for (const box of host.querySelectorAll<HTMLInputElement>('input[data-review-group-toggle]'))
    await act(async () => box.click());
  await waitFor(() => {
    const publish = headPublish();
    expect(publish).not.toBeNull();
    expect(publish?.disabled).toBe(false);
  });
}
/** The head line's "Publish N", which opens the confirmation. */
function headPublish() {
  return host.querySelector<HTMLButtonElement>('button[data-review-publish]');
}
async function openPublish() {
  await act(async () => headPublish()!.click());
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
async function mount(route = '/review', hasComparison = true) {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
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
    if (hasComparison) {
      expect(
        host.querySelector(
          'section[aria-label="Selected change"] section[aria-label$=" comparison"]',
        ),
      ).not.toBeNull();
    }
    const sidebar = host.querySelector('nav[aria-label="Pending saved changes"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar!.querySelector('[aria-busy="true"]')).toBeNull();
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
  useReviewQueue.getState().clearSelection();
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
      if (path === '/publish/ack') return Response.json({ acknowledged: true });
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

it('shows the effective German change in the tooltip detail and publish confirmation', async () => {
  const id = 'g_refill-0001';
  const en = { ...tooltip.text.en!, text: 'English <title Details [G_refill] />' };
  const live = {
    ...tooltip,
    text: { en, de: { ...en, text: 'Alt <title Details [G_refill] />' } },
  };
  const edited = { ...live, text: { en, de: { ...en, text: 'Neu <title Details [G_refill] />' } } };
  const english = {
    body: 'English note',
    revision: 'r1',
    updatedAt: en.updatedAt,
    updatedBy: en.updatedBy,
  };
  bundle.globals = {
    entries: [
      {
        version: 1,
        id,
        kind: 'titles',
        name: 'G_refill',
        revision: 'r2',
        nameHistory: [],
        definitions: {
          en: english,
          de: { ...english, body: 'Deutsche Notiz', sourceRevision: 'r1' },
        },
      },
    ],
    sync: { status: 'current', causeIds: [], lastFailure: null, causeEntries: {} },
  };
  bundle.globalsPending = [
    {
      id,
      kind: 'titles',
      name: 'G_refill',
      change: 'changed',
      digest: 'a'.repeat(64),
      affected: [10],
      languages: { de: { before: null, after: 'Deutsche Notiz' } },
    },
  ];
  const marker = await publishableHash(live);
  bundle.pushed[10] = marker;
  bundle.tooltips[10] = edited;
  const fetchHistory = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url.includes('/history/10?live=1')
        ? Promise.resolve(Response.json({ tooltip: live, pushedHash: marker }))
        : fetchHistory(url, init),
    ),
  );
  await mount('/review?hash=10', false);
  const detail = () => host.querySelector('section[aria-label="Selected change"]');
  await waitFor(() => expect(detail()?.textContent).toContain('No visible change'));
  await selectAll();
  await waitFor(() => {
    expect(detail()?.textContent).toContain('Text changed in German');
    expect(detail()?.querySelector('section[lang="de"]')?.textContent).toContain('Neu');
  });
  await openPublish();
  await waitFor(() => {
    const dialog = host.querySelector('dialog[open]');
    const row = [...(dialog?.querySelectorAll('li') ?? [])].find((item) =>
      item.textContent?.includes('Tooltip 10'),
    );
    expect(dialog?.textContent).toContain('1 tooltip with changed text goes live');
    expect(row?.textContent).toContain('Text changed');
  });
  await click('Cancel');
  await act(async () => useReviewQueue.getState().clearSelection());
  expect(detail()?.textContent).toContain('No visible change');
  expect(detail()?.querySelector('section[lang="de"]')).toBeNull();
});

it('loads a manually included migration leftover before confirming a removal selection', async () => {
  bundle.pushed[10] = await publishableHash(tooltip);
  bundle.tooltips[20] = { ...structuredClone(tooltip), hash: 20 };
  bundle.inactiveMoves = { 20: { by: 1, at: '2026-11-14T00:00:00Z' } };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: {
      10: { hash: 10, name: 'Tooltip 10', categoryId: 'other', icon: '', inGameDescription: '' },
    } as never,
    aliases: { 30: { to: 10, kind: 'frame' } },
  });
  await mount();
  await selectAll();
  await click('Show');
  const group = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Migration leftovers'),
  )!;
  await act(async () => group.click());
  const row = () => host.querySelector<HTMLAnchorElement>('a[data-review-hash="10"]');
  await waitFor(() => expect(row()).not.toBeNull());
  await act(async () => row()!.click());
  const include = () => host.querySelector<HTMLButtonElement>('footer[aria-label="Decide"] button');
  await waitFor(() => expect(include()?.textContent).toContain('Include'));
  await act(async () => include()!.click());
  await waitFor(() => {
    expect(headPublish()?.textContent).toContain('Publish 2');
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/history/10?live=1')),
    ).toBe(true);
  });
  await openPublish();
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Publish to live');
  expect(posts()).toHaveLength(0);
});

it('follows one reviewed request through Queued and Published', async () => {
  await mount();
  expect(host.textContent).toContain('1 change waiting to go live');
  await selectAll();
  await openPublish();
  const dialog = host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('Publish to live');
  expect(dialog.textContent).toContain('1 new tooltip goes live for everyone using Clarity.');
  expect(dialog.textContent).toContain('Tooltip 10');
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = posts()[0]!.body as { opId: string; hashes: number[]; expected: object };
  // One request for the whole confirmed selection.
  expect(Object.keys(body).sort()).toEqual(['expected', 'hashes', 'opId', 'selection']);
  expect(body).toMatchObject({ selection: 'whole' });
  expect(body.hashes).toEqual([10]);
  expect(body.expected).toEqual({ 10: await publishableHash(tooltip) });
  // The legacy path is never used with the flag on.
  expect(calls.some((c) => c.path === '/push-live')).toBe(false);
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Publishing, safe to close.');
    expect(activity.textContent).toContain('1 tooltip');
  });
  // Still pending in the list, but cannot be picked again.
  expect(host.textContent).toContain('1 change waiting to go live');
  expect(host.textContent).toContain('Publishing…');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  // The Worker finishes: the next status poll turns it into Published and clears the pending count.
  statusAnswer = 'done';
  postAnswer = () => Response.json({ opId: 'x', result: { status: 'done' } });
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Published');
    expect(host.textContent).toContain('0 changes waiting to go live');
  });
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(useReviewSession.getState().acknowledgments[10]).toEqual({
    digest: await publishableHash(tooltip),
    previous: undefined,
  });
  await click('Dismiss');
  await waitFor(() => expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull());
});

it('names an unselected pending import before confirmation, then publishes its reviewed closure', async () => {
  bundle.tooltips[10]!.text.en!.text = 'import main from 20';
  bundle.tooltips[20] = {
    ...structuredClone(tooltip),
    hash: 20,
    custom: { name: 'Dependency', categoryId: 'other' },
  };
  await mount();
  await waitFor(() => expect(host.querySelector('input[data-review-toggle="10"]')).not.toBeNull());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.click(),
  );
  await openPublish();
  expect(host.querySelector('dialog[open]')).toBeNull();
  expect(host.textContent).toContain('Include Dependency before publishing.');
  expect(posts()).toHaveLength(0);
  expect(useReviewSession.getState().pushing).toBe(false);
  await selectAll();
  await openPublish();
  await click('Publish 2');
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect((posts()[0]!.body as { hashes: number[] }).hashes.sort()).toEqual([10, 20]);
  expect(useReviewSession.getState().error).toBeUndefined();
});

it('shows stale and failed outcomes and leaves the tooltips pending', async () => {
  await mount();
  await selectAll();
  await openPublish();
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  statusAnswer = 'stale';
  // The status carries no reasons: the exact POST replays the terminal result.
  postAnswer = () =>
    Response.json({
      opId: 'x',
      result: {
        status: 'stale',
        held: [{ hash: 10, code: 'changed', reason: 'Saved text changed after review.' }],
      },
    });
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Attention');
    expect(activity.textContent).toContain(
      'Not published: Tooltip 10 (Saved text changed after review).',
    );
  });
  expect(host.textContent).toContain('1 change waiting to go live');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('publishes the rest of a whole selection and keeps a held row pending and selectable', async () => {
  bundle.tooltips[20] = {
    ...structuredClone(tooltip),
    hash: 20,
    custom: { name: 'Second', categoryId: 'other' },
  };
  await mount();
  await selectAll();
  await openPublish();
  vi.useFakeTimers({ toFake: ['Date'] });
  await click('Publish 2');
  await waitFor(() => expect(posts()).toHaveLength(1));
  statusAnswer = 'done';
  postAnswer = () =>
    Response.json({
      opId: 'x',
      result: {
        status: 'done',
        held: [{ hash: 20, code: 'changed', reason: 'Saved text changed after review.' }],
      },
    });
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Partly live');
    expect(activity.textContent).toContain(
      'Not published: Second (Saved text changed after review). The rest is live.',
    );
    expect(host.textContent).toContain('1 change waiting to go live');
  });
  expect(Object.keys(useReviewSession.getState().acknowledgments)).toEqual(['10']);
  // Touch and keyboard open the full reasons (no hover title there).
  const reasons = host.querySelector<HTMLElement>(
    '[aria-label="Publish activity"] [role="button"]',
  )!;
  expect(reasons.getAttribute('aria-expanded')).toBe('false');
  await act(async () => reasons.click());
  expect(reasons.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('[aria-label="Publish activity"] ul')!.getAttribute('aria-live')).toBe(
    'polite',
  );
  expect(host.querySelector<HTMLInputElement>('input[data-review-toggle="20"]')!.disabled).toBe(
    false,
  );
  // Dismissing a partly held publish acknowledges it for the account's other devices.
  await click('Dismiss');
  await waitFor(() =>
    expect(calls.find((c) => c.path === '/publish/ack')?.body).toMatchObject({
      opId: (posts()[0]!.body as { opId: string }).opId,
    }),
  );
});

it('retains the tick on unchanged text if the Worker refuses the queued publish', async () => {
  await mount();
  postAnswer = () => Response.json({ error: 'Upload lock is held' }, { status: 423 });
  await selectAll();
  await openPublish();
  await click('Publish 1');
  await waitFor(() =>
    expect(host.querySelector('[aria-label="Publish activity"]')?.textContent).toContain(
      'HTTP 423',
    ),
  );
  expect(useReviewQueue.getState().selected.has(10)).toBe(true);
});

it('keeps the operation and offers Retry once it has waited three minutes', async () => {
  await mount();
  await selectAll();
  await openPublish();
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
  // Manual recovery is available before the automatic kick threshold.
  expect(calls.filter((c) => c.path === '/publish/kick')).toHaveLength(0);
  await click('Retry');
  await waitFor(() => expect(calls.filter((c) => c.path === '/publish/kick')).toHaveLength(1));
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
  await openPublish();
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
    'Publishing, safe to close.',
  );
});

it('shows no publish controls or activity to accounts that cannot publish', async () => {
  useAuthStore.setState({ user: { ...user, role: 'trial' } });
  await mount();
  expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull();
  expect(headPublish()).toBeNull();
  expect(host.textContent).toContain('Sign in as an editor or maintainer to publish.');
});

it('flag off: the legacy push path and wording are unchanged and nothing is stored or polled', async () => {
  vi.stubEnv('VITE_PUBLISHER_ENABLED', '');
  await mount();
  await selectAll();
  await openPublish();
  expect(host.querySelector('dialog')!.textContent).toContain('Push to live');
  expect(buttons('Push 1 live')).toHaveLength(1);
  expect(host.querySelector('[aria-label="Publish activity"]')).toBeNull();
  expect(calls.filter((c) => c.path.startsWith('/publish'))).toEqual([]);
});
