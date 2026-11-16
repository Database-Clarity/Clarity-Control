// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryRouter,
  Routes,
  Route,
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { merge3, publishableHash, type Tooltip } from '@clarity/core';
import { Layout } from '../navigation/Layout';
import { ReviewPage } from './ReviewPage';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { loadGenerator } from '../../services/generator';
import { loadBundle, type Bundle } from '../../services/bundle';
import { useReviewSession } from './session';
import { pendingTooltips } from './model';
import { reviewRoute } from './route';
import { ReviewSidebar } from './ReviewSidebar';
import { useReviewQueue } from './queueStore';
import { resetPublished } from './published';
import { useAdvanceSetting } from '../compendium/advanceSetting';
import { useKinds } from './kinds';

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
  CompendiumWarmup: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));

const tooltip: Tooltip = {
  hash: 10,
  text: { en: { text: 'Saved', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
};
let bundle: Bundle;
let root: Root;
let host: HTMLDivElement;
let post: ReturnType<typeof vi.fn<(init?: RequestInit) => Promise<Response>>>;
const user = { id: 1, login: 'fixture', role: 'maintainer' as const };
function button(label: string) {
  // A button whose label carries a count in brackets matches without it.
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.textContent?.replace(/ \(\d+\)$/, '') === label,
  );
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
  // act flushes React updates, but does not await native crypto or transport work.
  await vi.waitFor(async () => {
    await flush();
    check();
  });
}
async function waitForReview() {
  await waitFor(() => {
    expect(useDataStore.getState().status).toBe('ready');
    expect(host.querySelector('article[aria-busy=true]')).toBeNull();
    expect(button('Refresh')).toBeDefined();
    expect(host.textContent).not.toContain('Loading saved changes…');
  });
}
async function waitForPush() {
  await waitFor(() => expect(useReviewSession.getState().pushing).toBe(false));
}
async function refresh() {
  expect(button('Refresh').disabled).toBe(false);
  await click('Refresh');
  await waitForReview();
}
/** The head line's numbers: [changes waiting, included]. */
function counts(): [number, number] {
  const line = host.querySelector('article > header p')?.textContent ?? '';
  const number = (match: RegExpExecArray | null) => Number(match?.[1]?.replace(/,/g, '') ?? 0);
  return [number(/^([\d,]+)/.exec(line)), number(/· ([\d,]+) included/.exec(line))];
}
/** The head line's "Publish N", which opens the confirmation. */
function headPublish() {
  return host.querySelector<HTMLButtonElement>('button[data-review-publish]');
}
async function openPublish() {
  await act(async () => headPublish()!.click());
  await flush();
}
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
// "Publish N" opens a confirmation; this is the whole gesture for one selected tooltip.
async function push() {
  await openPublish();
  await click('Push 1 live');
}
function ReturnPage() {
  return createElement('p', null, 'Compendium workspace');
}
async function chooseWorkspace(path: string) {
  await act(async () => {
    const link = host.querySelector<HTMLAnchorElement>(
      `nav[aria-label="Workspaces"] a[href^="${path}"]`,
    );
    if (!link) throw new Error(`Workspace tab ${path} is missing`);
    link.click();
  });
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
            createElement(Route, { path: '/compendium', element: createElement(ReturnPage) }),
          ),
        ),
      ),
    ),
  );
  await waitForReview();
}
beforeEach(async () => {
  // Published text and row words are module stores: each test starts without any.
  resetPublished();
  useKinds.setState({ byHash: {} });
  // The list's selection, collapse state, and scroll memory live in a module store.
  useReviewQueue.setState({
    entries: null,
    selected: new Set(),
    collapsed: new Set(),
    leftovers: 'hidden',
    scrollTop: 0,
  });
  useReviewSession.setState({
    acknowledgments: {},
    pushing: false,
    notice: undefined,
    error: undefined,
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no modal dialogs: show/hide is enough for the confirmation.
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
  bundle = {
    sourceCommit: 'baseline',
    generatedAt: '2026-01-01T00:00:00Z',
    tooltips: { 10: structuredClone(tooltip) },
    pushed: {},
    permissions: { users: {} },
  };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      // Only hash 10 is publishable; other fixture hashes are unlisted orphans.
      [10].map((hash) => [
        hash,
        { hash, name: `Tooltip ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  vi.mocked(loadBundle).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return structuredClone(bundle);
  });
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useAuthStore.setState({ user, loading: false, load: async () => {} });
  useDraftStore.setState({
    hydrated: true,
    hydrate: async () => {},
    activate: async () => {},
    drafts: {},
  });
  post = vi.fn(async () => {
    // Exercise real async boundaries instead of depending on one timer tick.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return Response.json({
      commit: 'a'.repeat(40),
      liveCommit: 'b'.repeat(40),
      pushed: { 10: await publishableHash(tooltip) },
      branch: 'synthetic-test',
    });
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://synthetic.invalid/push-live') return post(init);
      if (url.startsWith('https://synthetic.invalid/history/'))
        return Response.json(
          url.includes('live=1') ? { tooltip: null, pushedHash: null } : { page: 1, commits: [] },
        );
      throw Error(`Blocked network: ${url}`);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Router tests without the shell still need the left column: the filters and rows live there.
const withList = (page = <ReviewPage />) => (
  <>
    <ReviewSidebar />
    {page}
  </>
);

async function mountDelayedReview(review = withList()) {
  for (const hash of [20, 30]) bundle.tooltips[hash] = { ...structuredClone(tooltip), hash };
  // Published before: each change needs its published text (one background load for all).
  bundle.pushed = { 10: 'published', 20: 'published', 30: 'published' };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      [10, 20, 30].map((hash) => [
        hash,
        { hash, name: `Abacus ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  const requests: { hash: number; signal: AbortSignal; resolve: (text: string) => void }[] = [];
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, init) => {
    const match = String(url).match(/\/history\/(\d+)\?live=1$/);
    if (!match) return fallback(url, init);
    // Deliberately allow even aborted requests to finish: freshness must not
    // depend on the transport honoring cancellation.
    return new Promise<Response>((resolve) => {
      const hash = Number(match[1]);
      requests.push({
        hash,
        signal: init!.signal as AbortSignal,
        resolve: (text) =>
          resolve(
            Response.json({
              pushedHash: 'published',
              tooltip: {
                ...structuredClone(tooltip),
                hash,
                text: { en: { ...tooltip.text.en!, text } },
              },
            }),
          ),
      });
    });
  });
  const router = createMemoryRouter(
    [
      { path: '/other', element: <p>Other workspace</p> },
      { path: '/review', element: review, loader: reviewRoute },
    ],
    { initialEntries: ['/other'] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {
    void router.navigate('/review?hash=10');
  });
  return { router, requests };
}

async function typeSearch(letter: string) {
  const input = host.querySelector<HTMLInputElement>('input[type=search]')!;
  input.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      input.value + letter,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return input;
}

it('loads every published text once in the background; search keeps both letters meanwhile', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    expect(router.state.location.search).toBe('?hash=10');
    expect(router.state.navigation.state).toBe('idle');
    expect(host.querySelector('h1')?.textContent).toBe('Review changes');
    // Identity and the decision bar paint at once; only the sentence waits.
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 10');
    expect(host.querySelector('footer[aria-label="Decide"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Selected change"] [aria-busy="true"]')).not.toBeNull();
    // One background load for every published change, not one request per opened row.
    await waitFor(() => expect(requests.map(({ hash }) => hash)).toEqual([10, 20, 30]));
    await typeSearch('A');
    const input = await typeSearch('b');
    expect(input.value).toBe('Ab');
    expect(document.activeElement).toBe(input);
    expect(new URLSearchParams(router.state.location.search).get('query')).toBe('Ab');
    expect(requests).toHaveLength(3);
    expect(requests.some(({ signal }) => signal?.aborted)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  } finally {
    router.dispose();
  }
});

it('commits two ArrowDown selections without waiting for any request, and needs none per row', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    await waitFor(() => expect(requests).toHaveLength(3));
    for (const hash of [20, 30]) {
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
      });
      expect(new URLSearchParams(router.state.location.search).get('hash')).toBe(String(hash));
    }
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 30');
    expect(requests.map(({ hash }) => hash)).toEqual([10, 20, 30]);
    await act(async () => requests[2].resolve('Newest comparison'));
    await act(async () => requests[0].resolve('First item'));
    await act(async () => requests[1].resolve('Second item'));
    await waitFor(() =>
      expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
        'Text changed',
      ),
    );
    // The open change compares with its own published text only.
    expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
      'Newest comparison',
    );
    expect(host.textContent).not.toContain('First item');
    // Every row has its word, and moving back needs no request.
    await waitFor(() =>
      expect(
        [...host.querySelectorAll('a[data-review-hash] small')].map((word) => word.textContent),
      ).toEqual(['Text changed', 'Text changed', 'Text changed']),
    );
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
      'Second item',
    );
    expect(requests).toHaveLength(3);
  } finally {
    router.dispose();
  }
});

it('retains both arrow intents before React effects flush, and resets them for an external URL', async () => {
  const { router, requests } = await mountDelayedReview();
  const down = () =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  try {
    await act(async () => {
      // Both events use the same committed keydown handler. Neither a router
      // commit nor React's effects may be needed to retain the second intent.
      down();
      down();
    });
    expect(router.state.location.search).toBe('?hash=30');
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 30');
    expect(requests.at(-1)!.hash).toBe(30);
    await act(async () => router.navigate('/review?hash=10&query=Abacus'));
    await act(async () => {
      down();
      down();
    });
    expect(router.state.location.search).toBe('?hash=30&query=Abacus');
    await act(async () => router.navigate(-1));
    expect(router.state.location.search).toBe('?hash=30');
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    });
    expect(router.state.location.search).toBe('?hash=20');
    expect(post).not.toHaveBeenCalled();
  } finally {
    router.dispose();
  }
});

it('handles the second arrow between a router commit and passive listener effects', async () => {
  function KeyDuringCommit() {
    const location = useLocation();
    useLayoutEffect(() => {
      if (new URLSearchParams(location.search).get('hash') !== '20') return;
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    }, [location.search]);
    return <ReviewPage />;
  }
  const { router, requests } = await mountDelayedReview(withList(<KeyDuringCommit />));
  try {
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(router.state.location.search).toBe('?hash=30');
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 30');
    expect(requests.at(-1)!.hash).toBe(30);
  } finally {
    router.dispose();
  }
});

it('keeps pending comparisons and keyboard navigation from mutating behind the push dialog', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    await waitFor(() =>
      expect(host.querySelector('input[data-review-group-toggle]')).not.toBeNull(),
    );
    await selectAll();
    await openPublish();
    expect(host.querySelector('dialog[open]')).not.toBeNull();
    const focused = document.activeElement;
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      requests[0].resolve('Live text arriving behind the dialog');
    });
    expect(router.state.location.search).toBe('?hash=10');
    expect(document.activeElement).toBe(focused);
    expect(useDraftStore.getState().drafts).toEqual({});
    expect(post).not.toHaveBeenCalled();
    await click('Cancel');
    expect(counts()).toEqual([3, 3]);
  } finally {
    router.dispose();
  }
});

it('keeps the acknowledgment without reloading the bundle, then follows manual refreshes', async () => {
  await mount();
  expect(counts()).toEqual([1, 0]);
  await selectAll();
  await push();
  await waitForPush();
  await waitForReview();
  // A push never reloads the bundle: CI/CDN lag would resurrect pre-save text.
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  expect(counts()).toEqual([0, 0]);
  expect(host.textContent).toContain('Pushed 1 tooltip(s) to synthetic-test');
  const request = JSON.parse(post.mock.calls[0][0]!.body as string);
  expect(request).toEqual({ hashes: [10], expected: { 10: await publishableHash(tooltip) } });
  bundle.tooltips[10].text.en!.text = 'New saved content';
  await refresh();
  expect(counts()).toEqual([1, 0]);
  expect(host.textContent).toContain('New saved content');
  bundle.pushed[10] = await publishableHash(tooltip);
  await refresh();
  expect(useReviewSession.getState().acknowledgments).toEqual({});
  expect(counts()).toEqual([1, 0]);
  bundle.pushed[10] = await publishableHash(bundle.tooltips[10]);
  await refresh();
  expect(counts()).toEqual([0, 0]);
  // Once retired, the old local acknowledgment cannot hide a later authoritative marker.
  bundle.tooltips[10] = structuredClone(tooltip);
  await refresh();
  expect(counts()).toEqual([1, 0]);
});

it('selects pending changes from the sidebar and restores the selected item after returning', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  second.text.en!.text = 'Second saved edit';
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(counts()).toEqual([2, 0]));
  expect(host.textContent).toContain('1 / 2');

  const sidebarLink = host.querySelector<HTMLAnchorElement>(
    '[aria-label="Pending saved changes"] a[href="/review?hash=20"]',
  );
  expect(sidebarLink).not.toBeNull();
  await act(async () => sidebarLink!.click());
  expect(host.textContent).toContain('2 / 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');

  await chooseWorkspace('/compendium');
  await chooseWorkspace('/review');
  await waitFor(() => expect(counts()).toEqual([2, 0]));
  expect(host.textContent).toContain('2 / 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');
});

it.each(['/review', '/review?query=10'])(
  'keeps migration leftovers out of the counts and the list on %s',
  async (initialEntry) => {
    bundle.pushed[10] = await publishableHash(tooltip);
    vi.mocked(loadGenerator).mockResolvedValue({
      categories: [],
      items: {
        10: { hash: 10, name: 'Tooltip 10', categoryId: 'other', icon: '', inGameDescription: '' },
      } as never,
      aliases: { 30: { to: 10, kind: 'frame' } },
    });
    await useDataStore.getState().load();
    await pendingTooltips(useDataStore.getState().data!);
    const router = createMemoryRouter(
      [{ path: '/review', element: withList(), loader: reviewRoute }],
      { initialEntries: [initialEntry] },
    );
    try {
      await act(async () => root.render(<RouterProvider router={router} />));
      await waitForReview();
      expect(counts()[0]).toBe(0);
      // Leftovers are not changes: one quiet line, outside the counts and the list.
      expect(host.textContent).toContain('1 migration leftover hidden');
      expect(useReviewQueue.getState().leftovers).toBe('hidden');
      expect(host.querySelector('a[data-review-hash]')).toBeNull();
      expect(host.querySelector('article')?.textContent).toContain(
        'Nothing is waiting to go live.',
      );
    } finally {
      router.dispose();
    }
  },
);

it.each(['signed out'])(
  'shows one %s notice, leads with friendly categories, and finds by category name',
  async () => {
    const second = structuredClone(tooltip);
    second.hash = 20;
    second.text.en!.text = 'Second saved edit';
    bundle.tooltips[20] = second;
    vi.mocked(loadGenerator).mockResolvedValue({
      categories: [
        { id: 'weapon-trait', label: 'Friendly weapon traits', group: 'Weapons', order: 1 },
        { id: 'armor-perk', label: 'Friendly armor effects', group: 'Armor', order: 2 },
      ],
      items: {
        10: {
          hash: 10,
          name: 'Weapon sample',
          icon: '',
          categoryId: 'weapon-trait',
          inGameDescription: 'Weapon evidence',
        },
        20: {
          hash: 20,
          name: 'Long sword perk',
          icon: '',
          categoryId: 'armor-perk',
          inGameDescription: 'Armor evidence',
        },
      },
      aliases: {},
    });
    useAuthStore.setState({ user: null, loading: false, load: async () => {} });
    await mount();
    await waitFor(() => expect(counts()).toEqual([2, 0]));

    expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('Sign in to see latest change');
    expect(host.textContent).toContain('Friendly weapon traits');
    await waitFor(() =>
      expect(
        host.querySelector('[aria-label="Pending saved changes"] a[data-review-hash="10"]')
          ?.textContent,
      ).toContain('Weapon sample'),
    );
    // Signed out, the saved text still renders plain so the change can be judged.
    expect(host.querySelectorAll('[aria-label="Selected change"]')).toHaveLength(1);
    expect(host.querySelector('footer[aria-label="Decide"]')?.textContent).not.toContain('Include');
    await typeSearch('Friendly armor');
    await waitFor(() => expect(host.textContent).toContain('1 / 1'));
    expect(host.textContent).toContain('Friendly armor effects');
    expect(host.querySelector('article h2')?.textContent).toBe('Long sword perk');
    await waitFor(() =>
      expect(
        host
          .querySelector<HTMLAnchorElement>(
            '[aria-label="Pending saved changes"] a[aria-current="page"]',
          )
          ?.getAttribute('href'),
      ).toContain('hash=20'),
    );

    await act(async () => useAuthStore.setState({ user }));
    await waitFor(() => expect(host.querySelectorAll('[role="note"]')).toHaveLength(0));
    await act(async () =>
      useAuthStore.setState({ user: null, loading: false, load: async () => {} }),
    );
    await waitFor(() => expect(host.querySelectorAll('[role="note"]')).toHaveLength(1));
  },
);

it('retires acknowledgment when the bundle reports a superseding marker without catching up first', async () => {
  await mount();
  await selectAll();
  await push();
  await waitForPush();
  await waitForReview();
  const other = structuredClone(tooltip);
  other.text.en!.text = 'Other live version';
  bundle.pushed[10] = await publishableHash(other);
  await refresh();
  expect(counts()).toEqual([1, 0]);
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('suspends pending-review window shortcuts while the Drafts popover is open and restores them on close', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(counts()).toEqual([2, 0]));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-drafts-button]')!.click());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(host.textContent).toContain('1 / 2');
  expect(counts()).toEqual([2, 0]);
  expect(post).not.toHaveBeenCalled();
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(host.textContent).toContain('2 / 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');
});

it('does not reload the bundle after a push, so success is never masked by a refresh', async () => {
  await mount();
  await selectAll();
  await push();
  await waitForPush();
  expect(post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('Cannot load editor data');
  expect(useReviewSession.getState().notice).toContain('Pushed 1');
  expect(useReviewSession.getState().error).toBeUndefined();
  expect(counts()).toEqual([0, 0]);
});

it('keeps partial-live error details and never acknowledges a failed publish', async () => {
  await mount();
  post.mockResolvedValueOnce(
    new Response('partial live write: liveCommit=synthetic; markers not recorded', { status: 502 }),
  );
  await selectAll();
  await push();
  await waitForPush();
  expect(host.textContent).toContain(
    'partial live write: liveCommit=synthetic; markers not recorded',
  );
  expect(host.textContent).toContain('A failed push may have written live data');
  expect(counts()).toEqual([1, 1]);
  expect(useReviewSession.getState().acknowledgments).toEqual({});
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
});

it('holds the submission lock across unmount and account/role transitions', async () => {
  await mount();
  let resolve!: (response: Response) => void;
  post.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await selectAll();
  await push();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(useReviewSession.getState().pushing).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => useAuthStore.setState({ user: { ...user, id: 2, login: 'other' } }));
  await mount();
  expect(headPublish()!.disabled).toBe(true);
  await selectAll();
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => useAuthStore.setState({ user: { ...user, id: 2, role: 'translator' } }));
  await act(async () =>
    resolve(
      Response.json({
        commit: 'a',
        liveCommit: 'b',
        branch: 'synthetic-test',
        pushed: { 10: await publishableHash(tooltip) },
      }),
    ),
  );
  await waitForPush();
  await waitForReview();
  expect(useReviewSession.getState().pushing).toBe(false);
  expect(useReviewSession.getState().notice).toBeUndefined();
  expect(counts()).toEqual([0, 0]);
  expect(post).toHaveBeenCalledTimes(1);
});

it('aborts before sending when unmounted or account changes during digest calculation', async () => {
  await mount();
  await selectAll();
  await openPublish();
  await act(async () => {
    button('Push 1 live').click();
    useAuthStore.setState({ user: { ...user, role: 'translator' } });
  });
  await waitForPush();
  expect(post).not.toHaveBeenCalled();
  await act(async () => useAuthStore.setState({ user }));
  await selectAll();
  await openPublish();
  await act(async () => {
    button('Push 1 live').click();
    root.unmount();
  });
  root = createRoot(host);
  await waitForPush();
  expect(post).not.toHaveBeenCalled();
  expect(useReviewSession.getState().pushing).toBe(false);
});

it('clears reviewed selection on refresh and leaves keyboard events in controls alone', async () => {
  await mount();
  await selectAll();
  bundle.tooltips[10].text.en!.text = 'Unreviewed saved edit';
  await refresh();
  expect(counts()).toEqual([1, 0]);
  expect(headPublish()!.disabled).toBe(true);
  const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  button('Refresh').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(post).not.toHaveBeenCalled();
});

it('does not carry selections made against the old sidebar into a refreshed saved snapshot', async () => {
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  await act(async () =>
    root.render(<MemoryRouter initialEntries={['/review']}>{withList()}</MemoryRouter>),
  );
  await waitForReview();
  await waitFor(() => expect(host.querySelector('input[data-review-toggle="10"]')).not.toBeNull());
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal('scheduler', { yield: () => paused });
  try {
    await act(async () => {
      const newer = structuredClone(useDataStore.getState().data!);
      newer.bundle.tooltips[10].text.en!.text = 'Unreviewed replacement';
      useDataStore.setState({ data: newer });
    });
    // The old list and open change stay on screen while the replacement is compared.
    expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('false');
    expect(button('Refreshing…').disabled).toBe(true);
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.click(),
    );
    await act(async () => resume());
    await waitForReview();
    expect(useReviewQueue.getState().selected.size).toBe(0);
    expect(headPublish()!.disabled).toBe(true);
  } finally {
    await act(async () => resume());
  }
});

it('Enter includes the open change and moves on after the pause; U undoes and returns; S skips', async () => {
  for (const hash of [20, 30]) bundle.tooltips[hash] = { ...structuredClone(tooltip), hash };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      [10, 20, 30].map((hash) => [
        hash,
        { hash, name: `Tooltip ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  useAdvanceSetting.setState({ ms: 300 });
  await mount();
  const open = () => host.querySelector('article h2')?.textContent;
  const ticked = (hash: number) =>
    host.querySelector<HTMLInputElement>(`input[data-review-toggle="${hash}"]`)!.checked;
  const press = async (key: string, target: EventTarget = document.body) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  expect(open()).toBe('Tooltip 10');
  await press('Enter');
  // Included at once; the bar names the next change during the pause, which stays put.
  expect(ticked(10)).toBe(true);
  expect(counts()).toEqual([3, 1]);
  expect(host.querySelector('footer[aria-label="Decide"]')?.textContent).toContain(
    'Included. Next: Tooltip 20 · Esc to stay',
  );
  expect(open()).toBe('Tooltip 10');
  // Decisions wait for the pause: a second Enter moves now, once, without a second tick.
  await press('Enter');
  expect(open()).toBe('Tooltip 20');
  expect(counts()).toEqual([3, 1]);
  // The pause ends by itself too; Esc keeps the decided change open.
  await press(' ');
  expect(ticked(20)).toBe(true);
  await press('Escape');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
  expect(open()).toBe('Tooltip 20');
  // Undo reverts the last decision and returns to it; then the one before.
  await press('s');
  expect(open()).toBe('Tooltip 30');
  await press('u');
  expect(open()).toBe('Tooltip 20');
  expect(ticked(20)).toBe(false);
  await press('u');
  expect(open()).toBe('Tooltip 10');
  expect(ticked(10)).toBe(false);
  expect(counts()).toEqual([3, 0]);
  // On an included change the button reads Remove.
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.click(),
  );
  expect(button('Remove ↵')).toBeDefined();
  expect(host.querySelector('article')?.textContent).toContain('Included');
  // A focused control keeps Enter and Space for itself.
  await press(' ', button('Refresh'));
  await press('Enter', button('Refresh'));
  expect(counts()).toEqual([3, 1]);
  // R flips raw markup; P asks to publish exactly the selection.
  await press('r');
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Raw markup');
  await press('r');
  await press('p');
  expect(host.querySelector('dialog')?.textContent).toContain('Push 1 live');
  expect(post).not.toHaveBeenCalled();
  await click('Cancel');
  useAdvanceSetting.setState({ ms: 600 });
});

it('does not submit if the saved snapshot changes while digests are being computed', async () => {
  await mount();
  await selectAll();
  await openPublish();
  await act(async () => {
    button('Push 1 live').click();
    const data = useDataStore.getState().data!;
    const newer = structuredClone(data);
    newer.bundle.tooltips[10].text.en!.text = 'Unreviewed concurrent save';
    useDataStore.setState({ data: newer });
  });
  await waitForPush();
  await waitForReview();
  expect(post).not.toHaveBeenCalled();
  expect(useReviewSession.getState().pushing).toBe(false);
  expect(counts()).toEqual([1, 0]);
});

it('retires acknowledgment when its tooltip is removed from the bundle', async () => {
  await mount();
  await selectAll();
  await push();
  await waitForPush();
  await waitForReview();
  expect(Object.keys(useReviewSession.getState().acknowledgments)).toEqual(['10']);
  bundle.tooltips = {};
  await refresh();
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('restores the live text into a local draft only after confirmation', async () => {
  bundle.pushed = { 10: 'digest' };
  const live = structuredClone(tooltip);
  live.text.en!.text = 'Pushed text';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ tooltip: live, pushedHash: 'digest' })),
  );
  await mount();
  await waitFor(() => expect(button('Restore live text as draft').disabled).toBe(false));
  await click('Restore live text as draft');
  expect(useDraftStore.getState().drafts[10]).toBeUndefined();
  await click('Restore as draft');
  expect(useDraftStore.getState().drafts[10].next).toEqual(live);
  expect(useDraftStore.getState().drafts[10].base).toEqual(tooltip);
  expect(post).not.toHaveBeenCalled();
});

it('protects existing drafts on cancel and restricts translators to assigned languages', async () => {
  bundle.pushed = { 10: 'digest' };
  const live = structuredClone(tooltip);
  live.text.en!.text = 'Pushed English';
  live.text.de = { text: 'Pushed German', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' };
  const existing = structuredClone(tooltip);
  existing.text.en!.text = 'Existing draft';
  useDraftStore.setState({ drafts: { 10: { base: tooltip, next: existing } } });
  useAuthStore.setState({ user: { ...user, role: 'translator', languages: ['de'] } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ tooltip: live, pushedHash: 'digest' })),
  );
  await mount();
  await waitFor(() => expect(button('Restore live text as draft').disabled).toBe(false));
  await click('Restore live text as draft');
  expect(host.textContent).toContain('existing local draft');
  await click('Cancel');
  expect(useDraftStore.getState().drafts[10].next).toEqual(existing);
  await click('Restore live text as draft');
  await click('Restore as draft');
  expect(useDraftStore.getState().drafts[10].next.text.en!.text).toBe('Existing draft');
  expect(useDraftStore.getState().drafts[10].next.text.de!.text).toBe('Pushed German');
  expect(post).not.toHaveBeenCalled();
});

it('offers no restore for a change that was never published', async () => {
  await mount();
  await waitFor(() => expect(button('Restore live text as draft').disabled).toBe(true));
  expect(useDraftStore.getState().drafts).toEqual({});
});

it.each(['maintainer', 'translator'] as const)(
  'stages a pushed snapshot equal to a stale base for %s and keeps the correct editing base',
  async (role) => {
    bundle.pushed = { 10: 'digest' };
    const live = structuredClone(tooltip);
    live.text.de = {
      text: 'Pushed German',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'fixture',
    };
    const saved = structuredClone(tooltip);
    saved.text.de = { ...live.text.de, text: 'Saved German' };
    bundle.tooltips[10] = saved;
    const local = structuredClone(live);
    local.text.de!.text = 'Unsaved German';
    if (role === 'translator') local.text.en!.text = 'Unrelated local English';
    useDraftStore.setState({ drafts: { 10: { base: live, next: local } } });
    useAuthStore.setState({ user: { ...user, role, languages: ['de'] } });
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return Response.json({ tooltip: live, pushedHash: 'digest' });
    });
    vi.stubGlobal('fetch', fetchSpy);
    await mount();
    await waitFor(() => expect(button('Restore live text as draft').disabled).toBe(false));
    await click('Restore live text as draft');
    await click('Restore as draft');
    const draft = useDraftStore.getState().drafts[10];
    expect(draft.base.text.de).toEqual(saved.text.de);
    expect(draft.next.text.de).toEqual(live.text.de);
    if (role === 'translator') expect(draft.next.text.en).toEqual(local.text.en);
    const merged = merge3(draft.base, saved, draft.next);
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.merged.text.de).toEqual(live.text.de);
    useDraftStore.getState().edit(saved, 'de', 'Further edit', 'fixture');
    expect(useDraftStore.getState().drafts[10].base.text.de).toEqual(saved.text.de);
    expect(
      fetchSpy.mock.calls.every((call) => !call[1] || (call[1] as RequestInit).method === 'GET'),
    ).toBe(true);
  },
);

it('asks first: lists what goes live, and Cancel or Escape pushes nothing', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  bundle.tooltips[20] = second;
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      [10, 20].map((hash) => [
        hash,
        { hash, name: `Name ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  await mount();
  await selectAll();
  await openPublish();
  const dialog = host.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Push to live');
  expect(dialog.textContent).toContain('2 new tooltips go live');
  expect([...dialog.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    expect.stringContaining('Name 10'),
    expect.stringContaining('Name 20'),
  ]);
  expect(document.activeElement).toBe(button('Push 2 live'));
  expect(post).not.toHaveBeenCalled();
  await click('Cancel');
  expect(host.querySelector('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  expect(counts()).toEqual([2, 2]);
  await openPublish();
  await act(async () =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  );
  expect(host.querySelector('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('confirms once: a double-click or held Enter cannot send a second push', async () => {
  await mount();
  await selectAll();
  await openPublish();
  const confirm = button('Push 1 live');
  const held = new KeyboardEvent('keydown', {
    key: 'Enter',
    repeat: true,
    cancelable: true,
    bubbles: true,
  });
  await act(async () => confirm.dispatchEvent(held));
  expect(held.defaultPrevented).toBe(true);
  await act(async () => {
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  });
  expect(post).not.toHaveBeenCalled();
  await act(async () => {
    confirm.click();
    confirm.click();
    confirm.click();
  });
  await waitForPush();
  expect(post).toHaveBeenCalledTimes(1);
});

it('selects a whole group from its header and confirms exactly that selection', async () => {
  const hashes = [10, ...Array.from({ length: 15 }, (_, index) => index + 20)];
  for (const hash of hashes) bundle.tooltips[hash] = { ...structuredClone(tooltip), hash };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      hashes.map((hash) => [
        hash,
        {
          hash,
          name: `A complete pending tooltip name with several words ${hash}`,
          categoryId: 'other',
          icon: '',
          inGameDescription: '',
        },
      ]),
    ) as never,
    aliases: {},
  });
  await mount();
  await waitFor(() => expect(counts()[0]).toBe(16));
  const list = host.querySelector('[aria-label="Pending saved changes"]')!;
  const groupBox = list.querySelector<HTMLInputElement>('input[data-review-group-toggle]')!;
  expect(groupBox.getAttribute('aria-label')).toBe('Include all 16 in Other: other');
  // One row's checkbox makes the group's checkbox mixed; the group then selects the rest.
  await act(async () =>
    list.querySelector<HTMLInputElement>('input[data-review-toggle="21"]')!.click(),
  );
  expect(counts()).toEqual([16, 1]);
  expect(groupBox.indeterminate).toBe(true);
  await selectAll();
  expect(counts()).toEqual([16, 16]);
  expect(groupBox.checked).toBe(true);
  expect(groupBox.indeterminate).toBe(false);
  await openPublish();
  expect(host.querySelectorAll('dialog li')).toHaveLength(16);
  expect(button('Push 16 live')).toBeDefined();
  await click('Cancel');
  // The group's checkbox clears what it selected, and Clear empties the whole selection.
  await selectAll();
  expect(counts()).toEqual([16, 0]);
  await act(async () =>
    list.querySelector<HTMLInputElement>('input[data-review-toggle="22"]')!.click(),
  );
  await click('Clear');
  expect(counts()).toEqual([16, 0]);
});

it('does not cap the selection at 100', async () => {
  for (let hash = 20; hash < 140; hash++) {
    bundle.tooltips[hash] = { ...structuredClone(tooltip), hash };
  }
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      Array.from({ length: 131 }, (_, index) => index + 10).map((hash) => [
        hash,
        { hash, name: `Name ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  post.mockImplementationOnce(async (init) =>
    Response.json({
      commit: 'a'.repeat(40),
      liveCommit: 'b'.repeat(40),
      pushed: {},
      branch: 'synthetic-test',
      hashes: JSON.parse(init?.body as string).hashes.length,
    }),
  );
  await mount();
  await waitFor(() => expect(counts()[0]).toBe(121));
  // The group's checkbox selects every row, not only the rendered window.
  await selectAll();
  expect(counts()).toEqual([121, 121]);
  expect(host.textContent).not.toContain('at most 100');
  expect(headPublish()!.disabled).toBe(false);
  await openPublish();
  expect(host.querySelectorAll('dialog li')).toHaveLength(121);
  await click('Push 121 live');
  await waitForPush();
  expect(JSON.parse(post.mock.calls[0][0]!.body as string).hashes).toHaveLength(121);
});

it('Refresh keeps the list, the open change, and every row word on screen while it reloads', async () => {
  bundle.pushed = { 10: 'digest' };
  const live = structuredClone(tooltip);
  live.text.en!.text = 'Published text';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.includes('live=1') ? { tooltip: live, pushedHash: 'digest' } : { page: 1, commits: [] },
      ),
    ),
  );
  await mount();
  const word = () => host.querySelector('a[data-review-hash="10"] small')?.textContent;
  await waitFor(() => expect(word()).toBe('Text changed'));
  await act(async () => button('Refresh').click());
  // Mid-reload: nothing is torn down and the button says what is happening.
  expect(button('Refreshing…').disabled).toBe(true);
  expect(host.querySelector('article h2')?.textContent).toBe('Tooltip 10');
  expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
    'Text changed',
  );
  expect(word()).toBe('Text changed');
  await waitForReview();
  await waitFor(() => expect(button('Refresh').disabled).toBe(false));
  // The reloaded snapshot (new objects, same text) keeps its word without blanking.
  expect(word()).toBe('Text changed');
  expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
    'Text changed',
  );
});
