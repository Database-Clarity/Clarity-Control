// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicationSyncPendingCode, publishableHash, type Tooltip } from '@clarity/core';
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
    expect(
      host.querySelector(
        'section[aria-label="Selected change"] section[aria-label$=" comparison"]',
      ),
    ).not.toBeNull();
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

it.each([false, true])(
  'checks a pending aggregate before confirmation when the selection imports it (%s)',
  async (importsExports) => {
    bundle.tooltips[1] = {
      ...tooltip,
      hash: 1,
      custom: { name: 'Global exports', categoryId: 'other' },
    };
    if (importsExports) bundle.tooltips[10]!.text.en!.text = 'import main from 1';
    await mount();
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.click(),
    );
    if (importsExports) {
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })));
      expect(host.querySelector('dialog[open]')).toBeNull();
      expect(host.textContent).toContain('Include Global exports before publishing.');
      expect(posts()).toHaveLength(0);
      await act(async () =>
        host.querySelector<HTMLInputElement>('input[data-review-toggle="1"]')!.click(),
      );
    }
    await openPublish();
    const dialog = host.querySelector('dialog[open]')!;
    expect(dialog.textContent).toContain('Tooltip 10');
    expect(dialog.textContent?.includes('Global exports')).toBe(importsExports);
    await click('Cancel');
    expect(posts()).toHaveLength(0);
    await openPublish();
    await click(importsExports ? 'Publish 2' : 'Publish 1');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ hashes: importsExports ? [1, 10] : [10] });
  },
);

it('lists each export of the globals file, ticks them together, and publishes the one file', async () => {
  const text = (word: string) =>
    ['anti_barrier', 'overload', 'unstoppable']
      .map((name) => `${word} ${name} (\nText of ${name}\n)`)
      .join('\n\n');
  const file = (word: string): Tooltip => ({
    hash: 1,
    custom: { name: 'Global exports', categoryId: 'none' },
    text: { en: { ...tooltip.text.en!, text: text(word) } },
    associated: [],
  });
  bundle.tooltips = { 1: file('export') };
  // A change after the file, which a decision on it moves on to.
  bundle.tooltips[2] = {
    ...file('export'),
    hash: 2,
    custom: { name: 'Global variables', categoryId: 'none' },
    text: { en: { ...tooltip.text.en!, text: 'var a = 1' } },
  };
  bundle.pushed = { 1: 'live-marker' };
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, init) =>
    String(url).endsWith('/history/1?live=1')
      ? Promise.resolve(
          Response.json({ tooltip: file('export hidden'), pushedHash: 'live-marker' }),
        )
      : fallback(url, init),
  );
  await mount();
  const rows = () =>
    [...host.querySelectorAll<HTMLAnchorElement>('a[data-review-hash]')].map(
      (row) => row.textContent,
    );
  await waitFor(() =>
    expect(rows()).toEqual([
      'anti_barrierOutput unchanged',
      'overloadOutput unchanged',
      'unstoppableOutput unchanged',
      'aNew',
    ]),
  );
  expect(host.textContent).not.toContain('Global exports');
  expect(host.textContent).toContain('2 changes waiting to go live');
  expect(host.textContent).toContain('Globals · exports ticked together');
  const detail = () => host.querySelector('section[aria-label="Selected change"]')!;
  expect(detail().textContent).toContain(
    'Output unchanged. The published version hides this export; its text is the same.',
  );
  expect(detail().querySelector('ins, del')).toBeNull();
  expect(
    host.querySelector<HTMLAnchorElement>('a[href="/t/1?global=anti_barrier"]'),
  ).not.toBeNull();

  // Include on one export ticks all three, says so, and moves past the file.
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })));
  await waitFor(() => expect(host.querySelector('article h2')?.textContent).toBe('overload'));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
  const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[data-review-toggle="1"]')];
  expect(boxes().map(({ checked }) => checked)).toEqual([true, true, true]);
  expect(host.textContent).toContain(
    'anti_barrier, overload, and unstoppable: included in the publish.',
  );
  expect(host.textContent).toContain('1 included');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
  await waitFor(() => expect(host.querySelector('article h2')?.textContent).toBe('a'));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' })));
  expect(boxes().map(({ checked }) => checked)).toEqual([false, false, false]);
  await waitFor(() => expect(host.querySelector('article h2')?.textContent).toBe('overload'));

  await act(async () => boxes()[2]!.click());
  expect(boxes().map(({ checked }) => checked)).toEqual([true, true, true]);
  await openPublish();
  const dialog = host.querySelector('dialog[open]')!;
  expect(dialog.textContent).toContain('1 tooltip with unchanged output goes live');
  expect([...dialog.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
    'anti_barrier, overload, and unstoppableGlobals · 1Output unchanged',
  ]);
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]!.body).toMatchObject({
    hashes: [1],
    expected: { 1: await publishableHash(file('export')) },
  });
});

it('follows one reviewed request through Sync pending, Publishing, and Published', async () => {
  await mount();
  expect(host.textContent).toContain('1 change waiting to go live');
  await selectAll();
  await openPublish();
  const dialog = host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('Publish to live');
  expect(dialog.textContent).toContain('1 new tooltip goes live for everyone using Clarity.');
  expect(dialog.textContent).toContain('Tooltip 10');
  vi.useFakeTimers({ toFake: ['Date'] });
  const accepted = postAnswer;
  postAnswer = () =>
    Response.json(
      { error: 'Sync pending', details: { code: publicationSyncPendingCode } },
      { status: 409 },
    );
  await click('Publish 1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = posts()[0]!.body as { opId: string; hashes: number[]; expected: object };
  expect(Object.keys(body).sort()).toEqual(['expected', 'hashes', 'opId']);
  expect(body.hashes).toEqual([10]);
  expect(body.expected).toEqual({ 10: await publishableHash(tooltip) });
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Sync pending. Publishing will continue automatically.');
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  });
  postAnswer = accepted;
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]!.body).toEqual(body);
  // The legacy path is never used with the flag on.
  expect(calls.some((c) => c.path === '/push-live')).toBe(false);
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Publishing…');
    expect(activity.textContent).toContain('1 tooltip');
  });
  // Still pending in the list, but cannot be picked again.
  expect(host.textContent).toContain('1 change waiting to go live');
  expect(host.textContent).toContain('Publishing…');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  // The Worker finishes: the next status poll turns it into Published and clears the pending count.
  statusAnswer = 'done';
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
  expect((posts()[0]!.body as { hashes: number[] }).hashes).toEqual([10, 20]);
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
  vi.setSystemTime(Date.now() + publishTiming.pollMs(0) + 500);
  await act(async () => void (await publishDriver.refresh()));
  await waitFor(() => {
    const activity = host.querySelector('[aria-label="Publish activity"]')!;
    expect(activity.textContent).toContain('Changed');
    expect(activity.textContent).toContain('Nothing from this request went live');
  });
  expect(host.textContent).toContain('1 change waiting to go live');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
  expect(useReviewSession.getState().acknowledgments).toEqual({});
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
    'Publishing…',
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
