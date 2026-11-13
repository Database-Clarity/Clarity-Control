// @vitest-environment jsdom
import { act, createElement, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
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
import { beginReviewOpening, useReviewOpening } from './opening';
import { WorkThroughControl } from '../queue/QueueControl';
import { resetWorkQueues } from '../queue/store';
import { useWorkThrough } from '../queue/useQueue';

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
  // The publish button carries its count: "Push selected (2)".
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
    expect(host.textContent).not.toContain('Comparing publishable content...');
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
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
// "Push selected" opens a confirmation; this is the whole gesture for one selected tooltip.
async function push() {
  await click('Push selected');
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
  // A route test can unmount between opening frames. Its unfinished row slice
  // must not leak into the next test's independently mounted workspace.
  useReviewOpening.setState({
    token: 0,
    warming: false,
    limit: Infinity,
    required: 0,
    ready: true,
  });
  // The list's selection, collapse state, and scroll memory live in a module store.
  useReviewQueue.setState({
    entries: null,
    selected: new Set(),
    collapsed: new Set(),
    markerOpen: false,
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

it('canonicalizes a plain data-router open with one live request and preserves Back and fresh revisits', async () => {
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  const mountedSearches: string[] = [];
  function ObservedReview() {
    useEffect(() => {
      mountedSearches.push(router.state.location.search);
    }, []);
    return <ReviewPage />;
  }
  const router = createMemoryRouter(
    [
      { path: '/other', element: <p>Other workspace</p> },
      {
        path: '/review',
        element: <ObservedReview />,
        loader: reviewRoute,
      },
    ],
    { initialEntries: ['/other'] },
  );
  const liveRequests = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('live=1'));
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => router.navigate('/review'));
    await waitForReview();
    await waitFor(() => {
      expect(router.state.location.search).toBe('?hash=10');
      expect(router.state.navigation.state).toBe('idle');
    });
    expect(router.state.historyAction).toBe('PUSH');
    expect(mountedSearches).toEqual(['?hash=10']);
    expect(liveRequests()).toHaveLength(1);
    expect(host.textContent).not.toContain('Loading last pushed text...');
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/other');
    await act(async () => router.navigate('/review'));
    await waitForReview();
    await waitFor(() => expect(router.state.location.search).toBe('?hash=10'));
    expect(liveRequests()).toHaveLength(2);
    expect(mountedSearches).toEqual(['?hash=10', '?hash=10']);
  } finally {
    router.dispose();
  }
});

it('keeps main controls usable while the sidebar links warm', async () => {
  bundle.tooltips[20] = { ...structuredClone(tooltip), hash: 20 };
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const router = createMemoryRouter(
    [
      { path: '/other', element: <p>Other workspace</p> },
      { path: '/review', element: <ReviewPage />, loader: reviewRoute },
    ],
    { initialEntries: ['/other'] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => router.navigate('/review'));
    expect(host.querySelector('article')!.getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('fieldset')).toBeNull();
    expect(host.textContent).toContain('Loading sidebar…');
    await act(async () =>
      host
        .querySelector<HTMLInputElement>(
          'section[aria-label="Selected change"] input[type=checkbox]:not([role=switch])',
        )!
        .click(),
    );
    expect(host.textContent).toContain('1 selected');
    await act(async () =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      ),
    );
    expect(router.state.location.search).toBe('?hash=20');
    for (let round = 0; round < 12 && frames.size; round++) {
      const batch = [...frames];
      frames.clear();
      await act(async () => {
        batch.forEach(([, callback]) => callback(performance.now()));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(host.textContent).toContain('Review ready.');
    expect(host.textContent).toContain('1 selected');
    expect(post).not.toHaveBeenCalled();
  } finally {
    router.dispose();
  }
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

it('commits the Review heading and preserves both search letters while live GETs are pending', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    expect(router.state.location.search).toBe('?hash=10');
    expect(router.state.navigation.state).toBe('idle');
    expect(host.querySelector('h1')?.textContent).toBe('Review changes');
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 10');
    expect(requests).toHaveLength(1);
    expect(
      host.querySelector('[role=status][aria-label="Loading last pushed text"]'),
    ).not.toBeNull();
    await typeSearch('A');
    const input = await typeSearch('b');
    expect(input.value).toBe('Ab');
    expect(document.activeElement).toBe(input);
    expect(new URLSearchParams(router.state.location.search).get('query')).toBe('Ab');
    expect(requests).toHaveLength(3);
    expect(requests.slice(0, -1).every(({ signal }) => signal.aborted)).toBe(true);
    expect(requests.at(-1)!.signal.aborted).toBe(false);
    expect(post).not.toHaveBeenCalled();
  } finally {
    router.dispose();
  }
});

it('commits two ArrowDown selections without waiting for any live GET', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
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
    expect(requests.slice(0, -1).every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => requests[2].resolve('Newest comparison'));
    await act(async () => requests[0].resolve('Stale first item'));
    await act(async () => requests[1].resolve('Stale second item'));
    await waitFor(() =>
      expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
        'Newest comparison',
      ),
    );
    expect(host.textContent).not.toContain('Stale first item');
    expect(host.textContent).not.toContain('Stale second item');
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

it('discards older same-item search responses, and aborts the comparison on unmount', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    await typeSearch('A');
    await typeSearch('b');
    expect(requests.map(({ hash }) => hash)).toEqual([10, 10, 10]);
    await act(async () => requests[2].resolve('Current search comparison'));
    await act(async () => requests[1].resolve('Older search comparison'));
    await act(async () => requests[0].resolve('Original comparison'));
    const detail = host.querySelector('[aria-label="Selected change"]')!;
    await waitFor(() => expect(detail.textContent).toContain('Current search comparison'));
    expect(detail.textContent).not.toContain('Older search comparison');
    expect(detail.textContent).not.toContain('Original comparison');
    await act(async () => router.navigate('/review?hash=20'));
    const pending = requests.at(-1)!;
    expect(pending.signal.aborted).toBe(false);
    await act(async () => router.navigate('/other'));
    expect(pending.signal.aborted).toBe(true);
    await act(async () => pending.resolve('After unmount'));
    expect(host.textContent).toBe('Other workspace');
    await act(async () => router.navigate(-1));
    expect(host.querySelector('article h2')?.textContent).toBe('Abacus 20');
    expect(requests.at(-1)).not.toBe(pending);
    expect(host.textContent).not.toContain('After unmount');
  } finally {
    router.dispose();
  }
});

it('keeps pending comparisons and keyboard navigation from mutating behind the push dialog', async () => {
  const { router, requests } = await mountDelayedReview();
  try {
    // The list's rows (and their group checkbox) mount once the opening frames have painted.
    await waitFor(() => expect(host.textContent).toContain('Review ready.'));
    await selectAll();
    await click('Push selected');
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
    expect(host.textContent).toContain('3 changes · 3 selected');
  } finally {
    router.dispose();
  }
});

it('lets the local workspace paint before presenting a fast background comparison', async () => {
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const { router, requests } = await mountDelayedReview();
  try {
    expect(host.querySelector('h1')?.textContent).toBe('Review changes');
    expect(host.textContent).toContain('Loading sidebar…');
    await act(async () => requests[0].resolve('Fast background comparison'));
    expect(host.querySelector('[aria-label="Selected change"]')?.textContent).not.toContain(
      'Fast background comparison',
    );
    for (let round = 0; round < 12 && frames.size; round++) {
      const batch = [...frames];
      frames.clear();
      await act(async () => {
        batch.forEach(([, callback]) => callback(performance.now()));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(host.textContent).toContain('Review ready.');
    expect(host.querySelector('[aria-label="Selected change"]')?.textContent).toContain(
      'Fast background comparison',
    );
  } finally {
    router.dispose();
  }
});

it('never shows the comparison skeleton for a response held for the opening paint', async () => {
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const { router, requests } = await mountDelayedReview();
  const detail = () => host.querySelector('[aria-label="Selected change"]')!;
  const runFrame = () => {
    const batch = [...frames];
    frames.clear();
    flushSync(() => batch.forEach(([, callback]) => callback(performance.now())));
  };
  try {
    await act(async () => requests[0].resolve('Held comparison'));
    // Browser order when the row slice runs long: the second frame's callbacks
    // run before the opening's post-paint timer releases the held response.
    act(runFrame);
    act(runFrame);
    expect(detail().querySelector('[aria-busy=true] [aria-hidden=true]')).toBeNull();
    // The release lands within the opening's own frames, not after a skeleton minimum.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    for (let round = 0; round < 12 && frames.size; round++)
      await act(async () => {
        runFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(detail().textContent).toContain('Held comparison');
  } finally {
    router.dispose();
  }
});

it('commits a comparison received after the first row slice before its skeleton can show', async () => {
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const { router, requests } = await mountDelayedReview();
  const detail = () => host.querySelector('[aria-label="Selected change"]')!;
  const runFrame = () => {
    const batch = [...frames];
    frames.clear();
    flushSync(() => batch.forEach(([, callback]) => callback(performance.now())));
  };
  try {
    // First paint, then the first row slice: the hold is over, the opening still runs.
    act(runFrame);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(useReviewOpening.getState().limit).toBeGreaterThan(0);
    // The response is processed without any later task (the row slices own
    // those); the skeleton's second frame follows right after.
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    requests[0].resolve('Received during the slices');
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    act(runFrame);
    expect(detail().querySelector('[aria-busy=true] [aria-hidden=true]')).toBeNull();
    expect(detail().textContent).toContain('Received during the slices');
  } finally {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    router.dispose();
  }
});

it('still shows the comparison skeleton for a wait that outlasts the opening', async () => {
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const { router } = await mountDelayedReview();
  const detail = () => host.querySelector('[aria-label="Selected change"]')!;
  try {
    for (let round = 0; round < 12 && frames.size; round++) {
      const batch = [...frames];
      frames.clear();
      await act(async () => {
        batch.forEach(([, callback]) => callback(performance.now()));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(useReviewOpening.getState().warming).toBe(false);
    expect(detail().querySelector('[aria-busy=true] [aria-hidden=true]')).not.toBeNull();
  } finally {
    router.dispose();
  }
});

it('keeps current filters when a retained row opens after the URL changes', async () => {
  bundle.tooltips[20] = { ...structuredClone(tooltip), hash: 20 };
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  const router = createMemoryRouter(
    [
      {
        path: '/review',
        element: withList(),
        loader: reviewRoute,
      },
    ],
    { initialEntries: ['/review?hash=10'] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await waitForReview();
    await waitFor(() => expect(host.textContent).toContain('Review ready.'));
    const row = host.querySelector<HTMLAnchorElement>('a[data-review-hash="20"]')!;
    expect(row).not.toBeNull();
    await act(async () => router.navigate('/review?hash=10&query=Tooltip'));
    await waitForReview();
    expect(host.querySelector('a[data-review-hash="20"]')).toBe(row);
    await act(async () => row.click());
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get('query')).toBe('Tooltip');
      expect(params.get('hash')).toBe('20');
      expect(host.querySelector('article h2')?.textContent).toBe('Tooltip 20');
    });
  } finally {
    router.dispose();
  }
});

it('keeps the acknowledgment without reloading the bundle, then follows manual refreshes', async () => {
  await mount();
  expect(host.textContent).toContain('1 change · 0 selected');
  await selectAll();
  await push();
  await waitForPush();
  await waitForReview();
  // A push never reloads the bundle: CI/CDN lag would resurrect pre-save text.
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('0 changes · 0 selected');
  expect(host.textContent).toContain('Pushed 1 tooltip(s) to synthetic-test');
  const request = JSON.parse(post.mock.calls[0][0]!.body as string);
  expect(request).toEqual({ hashes: [10], expected: { 10: await publishableHash(tooltip) } });
  bundle.tooltips[10].text.en!.text = 'New saved content';
  await refresh();
  expect(host.textContent).toContain('1 change · 0 selected');
  expect(host.textContent).toContain('New saved content');
  bundle.pushed[10] = await publishableHash(tooltip);
  await refresh();
  expect(useReviewSession.getState().acknowledgments).toEqual({});
  expect(host.textContent).toContain('1 change · 0 selected');
  bundle.pushed[10] = await publishableHash(bundle.tooltips[10]);
  await refresh();
  expect(host.textContent).toContain('0 changes · 0 selected');
  // Once retired, the old local acknowledgment cannot hide a later authoritative marker.
  bundle.tooltips[10] = structuredClone(tooltip);
  await refresh();
  expect(host.textContent).toContain('1 change · 0 selected');
});

it('selects pending changes from the sidebar and restores the selected item after returning', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  second.text.en!.text = 'Second saved edit';
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(host.textContent).toContain('2 changes · 0 selected'));
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
  await waitFor(() => expect(host.textContent).toContain('2 changes · 0 selected'));
  expect(host.textContent).toContain('2 / 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');
});

it('reopens a previously viewed marker group when Back returns to its selected row', async () => {
  const marker = { ...structuredClone(tooltip), hash: 20 };
  bundle.tooltips[20] = marker;
  bundle.pushed[20] = await publishableHash(marker);
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      [10, 20].map((hash) => [
        hash,
        {
          hash,
          name: `Tooltip ${hash}`,
          categoryId: 'other',
          icon: '',
          inGameDescription: '',
        },
      ]),
    ) as never,
    aliases: { 30: { to: 20, kind: 'frame' } },
  });
  await useDataStore.getState().load();
  await pendingTooltips(useDataStore.getState().data!);
  const router = createMemoryRouter(
    [{ path: '/review', element: withList(), loader: reviewRoute }],
    { initialEntries: ['/review?hash=10'] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await waitForReview();
    await act(async () => router.navigate('/review?hash=20'));
    await waitFor(() => expect(useReviewQueue.getState().markerOpen).toBe(true));
    await act(async () => useReviewQueue.getState().toggleGroup('~marker-only'));
    expect(useReviewQueue.getState().markerOpen).toBe(false);
    await act(async () => router.navigate('/review?hash=10'));
    await act(async () => router.navigate(-1));
    expect(router.state.location.search).toBe('?hash=20');
    expect(host.querySelector('article h2')?.textContent).toBe('Tooltip 20');
    expect(useReviewQueue.getState().markerOpen).toBe(true);
  } finally {
    router.dispose();
  }
});

it.each(['/review', '/review?query=10'])(
  'keeps a marker-only queue collapsed with an explanatory state on %s',
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
      expect(host.textContent).toContain('0 changes');
      expect(host.textContent).toContain('1 marker-only');
      expect(useReviewQueue.getState().markerOpen).toBe(false);
      expect(host.querySelector('article')?.textContent).toContain(
        'No changes made by a person are waiting to go live.',
      );
    } finally {
      router.dispose();
    }
  },
);

it.each([false, true])(
  'shows one anonymous notice, leads with friendly categories, and filters canonical IDs (opening: %s)',
  async (opening) => {
    if (opening) {
      // Keep the opening frames slower than the detail's filter update.
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 50),
      );
      vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
      beginReviewOpening(false);
    }
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
    await waitFor(() => expect(host.textContent).toContain('2 changes · 0 selected'));

    expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('Sign in to see latest change');
    expect(host.textContent).toContain('Friendly weapon traits');
    // The list's rows mount once the opening frames have painted.
    await waitFor(() =>
      expect(
        host.querySelector('[aria-label="Pending saved changes"] a[aria-label="Weapon sample 10"]')
          ?.textContent,
      ).toContain('Weapon sample'),
    );
    expect(host.querySelectorAll('[aria-label="Selected change"]')).toHaveLength(0);

    const category = host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
    await act(async () => {
      category.value = 'armor-perk';
      category.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(host.textContent).toContain('1 / 1'));
    expect(host.textContent).toContain('Friendly armor effects');
    expect(host.querySelector('article h2')?.textContent).toBe('Long sword perk');
    // The detail can update while opening still mounts the filtered sidebar rows.
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
  expect(host.textContent).toContain('1 change · 0 selected');
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('suspends pending-review window shortcuts while the Drafts popover is open and restores them on close', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(host.textContent).toContain('2 changes · 0 selected'));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-drafts-button]')!.click());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(host.textContent).toContain('1 / 2');
  expect(host.textContent).toContain('2 changes · 0 selected');
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
  expect(host.textContent).toContain('0 changes · 0 selected');
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
  expect(host.textContent).toContain('1 change · 1 selected');
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
  expect(button('Pushing...').disabled).toBe(true);
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
  expect(host.textContent).toContain('0 changes · 0 selected');
  expect(post).toHaveBeenCalledTimes(1);
});

it('aborts before sending when unmounted or account changes during digest calculation', async () => {
  await mount();
  await selectAll();
  await click('Push selected');
  await act(async () => {
    button('Push 1 live').click();
    useAuthStore.setState({ user: { ...user, role: 'translator' } });
  });
  await waitForPush();
  expect(post).not.toHaveBeenCalled();
  await act(async () => useAuthStore.setState({ user }));
  await selectAll();
  await click('Push selected');
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
  expect(host.textContent).toContain('1 change · 0 selected');
  expect(button('Push selected').disabled).toBe(true);
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
    expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    // The old sidebar stays mounted while the replacement's fingerprints are pending.
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.click(),
    );
    await act(async () => resume());
    await waitForReview();
    expect(useReviewQueue.getState().selected.size).toBe(0);
    expect(button('Push selected').disabled).toBe(true);
  } finally {
    await act(async () => resume());
  }
});

it('Space includes the open change, P asks to publish exactly that selection, controls keep their keys', async () => {
  await mount();
  const include = () =>
    host.querySelector<HTMLInputElement>(
      'label input[type="checkbox"][aria-label^="Include"], section[aria-label="Selected change"] input[type="checkbox"]',
    )!;
  expect(host.textContent).toContain('0 selected');
  const press = async (key: string, target: EventTarget = document.body) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  await press(' ');
  expect(host.textContent).toContain('1 selected');
  expect(include().checked).toBe(true);
  // A focused control keeps Space for itself.
  await press(' ', button('Refresh'));
  expect(host.textContent).toContain('1 selected');
  await press('p');
  expect(host.textContent).toContain('Push 1 live');
  expect(post).not.toHaveBeenCalled();
  await click('Cancel');
  await press(' ');
  expect(host.textContent).toContain('0 selected');
});

it('does not submit if the saved snapshot changes while digests are being computed', async () => {
  await mount();
  await selectAll();
  await click('Push selected');
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
  expect(host.textContent).toContain('1 change · 0 selected');
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

it('loads the pushed snapshot into a local draft only after confirmation', async () => {
  const live = structuredClone(tooltip);
  live.text.en!.text = 'Pushed text';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ tooltip: live, pushedHash: 'digest' })),
  );
  await mount();
  await waitFor(() => expect(button('Load last pushed as draft').disabled).toBe(false));
  await click('Load last pushed as draft');
  expect(useDraftStore.getState().drafts[10]).toBeUndefined();
  await click('Confirm load as draft');
  expect(useDraftStore.getState().drafts[10].next).toEqual(live);
  expect(useDraftStore.getState().drafts[10].base).toEqual(tooltip);
  expect(post).not.toHaveBeenCalled();
});

it('protects existing drafts on cancel and restricts translators to assigned languages', async () => {
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
  await waitFor(() => expect(button('Load last pushed as draft').disabled).toBe(false));
  await click('Load last pushed as draft');
  expect(host.textContent).toContain('existing local draft');
  await click('Cancel');
  expect(useDraftStore.getState().drafts[10].next).toEqual(existing);
  await click('Load last pushed as draft');
  await click('Confirm load as draft');
  expect(useDraftStore.getState().drafts[10].next.text.en!.text).toBe('Existing draft');
  expect(useDraftStore.getState().drafts[10].next.text.de!.text).toBe('Pushed German');
  expect(post).not.toHaveBeenCalled();
});

it('disables loading when no pushed snapshot is available', async () => {
  await mount();
  await waitFor(() => expect(button('Load last pushed as draft').disabled).toBe(true));
  expect(useDraftStore.getState().drafts).toEqual({});
});

it.each(['maintainer', 'translator'] as const)(
  'stages a pushed snapshot equal to a stale base for %s and keeps the correct editing base',
  async (role) => {
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
    await waitFor(() => expect(button('Load last pushed as draft').disabled).toBe(false));
    await click('Load last pushed as draft');
    await click('Confirm load as draft');
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
  await click('Push selected');
  const dialog = host.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Push to live');
  expect(dialog.textContent).toContain('2 tooltips go live');
  expect([...dialog.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    expect.stringContaining('Name 10'),
    expect.stringContaining('Name 20'),
  ]);
  expect(document.activeElement).toBe(button('Push 2 live'));
  expect(post).not.toHaveBeenCalled();
  await click('Cancel');
  expect(host.querySelector('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  expect(host.textContent).toContain('2 changes · 2 selected');
  await click('Push selected');
  await act(async () =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  );
  expect(host.querySelector('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('confirms once: a double-click or held Enter cannot send a second push', async () => {
  await mount();
  await selectAll();
  await click('Push selected');
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
  await waitFor(() => expect(host.textContent).toContain('16 changes'));
  const list = host.querySelector('[aria-label="Pending saved changes"]')!;
  const groupBox = list.querySelector<HTMLInputElement>('input[data-review-group-toggle]')!;
  expect(groupBox.getAttribute('aria-label')).toBe('Select all 16 in Other: other');
  // One row's checkbox makes the group's checkbox mixed; the group then selects the rest.
  await act(async () =>
    list.querySelector<HTMLInputElement>('input[data-review-toggle="21"]')!.click(),
  );
  expect(host.textContent).toContain('16 changes · 1 selected');
  expect(groupBox.indeterminate).toBe(true);
  await selectAll();
  expect(host.textContent).toContain('16 changes · 16 selected');
  expect(groupBox.checked).toBe(true);
  expect(groupBox.indeterminate).toBe(false);
  await click('Push selected');
  expect(host.querySelectorAll('dialog li')).toHaveLength(16);
  expect(button('Push 16 live')).toBeDefined();
  await click('Cancel');
  // The group's checkbox clears what it selected, and Clear empties the whole selection.
  await selectAll();
  expect(host.textContent).toContain('16 changes · 0 selected');
  await act(async () =>
    list.querySelector<HTMLInputElement>('input[data-review-toggle="22"]')!.click(),
  );
  await click('Clear');
  expect(host.textContent).toContain('16 changes · 0 selected');
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
  await waitFor(() => expect(host.textContent).toContain('121 changes'));
  // The group's checkbox selects every row, not only the rendered window.
  await selectAll();
  expect(host.textContent).toContain('121 changes · 121 selected');
  expect(host.textContent).not.toContain('at most 100');
  expect(button('Push selected').disabled).toBe(false);
  await click('Push selected');
  expect(host.querySelectorAll('dialog li')).toHaveLength(121);
  await click('Push 121 live');
  await waitForPush();
  expect(JSON.parse(post.mock.calls[0][0]!.body as string).hashes).toHaveLength(121);
});

it('works through selected changes in the editor; Leave keeps only the unsaved ones picked', async () => {
  for (const hash of [20, 30]) bundle.tooltips[hash] = { ...structuredClone(tooltip), hash };
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
  resetWorkQueues();
  let location: ReturnType<typeof useLocation> | undefined;
  function Editor() {
    location = useLocation();
    const work = useWorkThrough(location.state);
    return <div data-editor>{work && <WorkThroughControl work={work} />}</div>;
  }
  function Review() {
    location = useLocation();
    return withList();
  }
  const router = createMemoryRouter(
    [
      { path: '/review', element: <Review /> },
      { path: '/t/:hash', element: <Editor /> },
    ],
    { initialEntries: ['/review'] },
  );
  const position = () => host.querySelector('[data-queue] [role="status"]')?.textContent;
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await waitForReview();
    for (const hash of [10, 20])
      await act(async () =>
        host.querySelector<HTMLInputElement>(`input[data-review-toggle="${hash}"]`)!.click(),
      );
    expect(host.textContent).toContain('2 selected');
    expect(button('Work through all 3 shown')).toBeDefined();
    await click('Work through 2 selected');
    expect(location!.pathname).toBe('/t/10');
    expect(position()).toBe('1 of 2');
    // A save of the open change finishes it; membership stays as it was.
    const data = useDataStore.getState().data!;
    act(() =>
      useDataStore.setState({
        data: {
          ...data,
          bundle: {
            ...data.bundle,
            tooltips: {
              ...data.bundle.tooltips,
              10: {
                ...data.bundle.tooltips[10]!,
                text: {
                  en: { text: 'Saved again', updatedAt: '2026-02-01T00:00:00Z', updatedBy: 'x' },
                },
              },
            },
          },
        },
      }),
    );
    expect(position()).toBe('Done · 1 left');
    await act(async () =>
      [...host.querySelectorAll<HTMLAnchorElement>('[data-queue] a')]
        .find((link) => link.getAttribute('aria-label')?.startsWith('Next in queue'))!
        .click(),
    );
    expect(location!.pathname).toBe('/t/20');
    // The position counts what is left to do.
    expect(position()).toBe('1 of 1');
    await act(async () =>
      [...host.querySelectorAll<HTMLAnchorElement>('[data-queue] a')]
        .find((link) => link.textContent === 'Review changes')!
        .click(),
    );
    await waitForReview();
    expect(location!.pathname).toBe('/review');
    expect(location!.search).toContain('hash=10');
    // The saved change is unreviewed again: only the untouched one is picked.
    await waitFor(() => expect(host.textContent).toContain('1 selected'));
    expect(host.querySelector<HTMLInputElement>('input[data-review-toggle="20"]')!.checked).toBe(
      true,
    );
    expect(host.querySelector<HTMLInputElement>('input[data-review-toggle="10"]')!.checked).toBe(
      false,
    );
  } finally {
    router.dispose();
  }
});
