// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, createMemoryRouter, RouterProvider } from 'react-router-dom';
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
import { reviewRoute, shouldRevalidateReview } from './route';

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
let bundle: Bundle;
let root: Root;
let host: HTMLDivElement;
let post: ReturnType<typeof vi.fn<(init?: RequestInit) => Promise<Response>>>;
const user = { id: 1, login: 'fixture', role: 'maintainer' as const };
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw Error(`Missing button ${label}: ${host.textContent}`);
  return found;
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    expect(button('Refresh saved changes')).toBeDefined();
  });
}
async function waitForPush() {
  await waitFor(() => expect(useReviewSession.getState().pushing).toBe(false));
}
async function refresh() {
  expect(button('Refresh saved changes').disabled).toBe(false);
  await click('Refresh saved changes');
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
  const router = createMemoryRouter(
    [
      { path: '/other', element: <p>Other workspace</p> },
      {
        path: '/review',
        element: <ReviewPage />,
        loader: reviewRoute,
        shouldRevalidate: shouldRevalidateReview,
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
    expect(router.state.historyAction).toBe('REPLACE');
    expect(liveRequests()).toHaveLength(1);
    expect(host.textContent).not.toContain('Loading last pushed text...');
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/other');
    await act(async () => router.navigate('/review'));
    await waitForReview();
    await waitFor(() => expect(router.state.location.search).toBe('?hash=10'));
    expect(liveRequests()).toHaveLength(2);
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
        element: <ReviewPage />,
        loader: reviewRoute,
        shouldRevalidate: shouldRevalidateReview,
      },
    ],
    { initialEntries: ['/review?hash=10'] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await waitForReview();
    const row = host.querySelector<HTMLButtonElement>('button[aria-label^="Open Tooltip 20,"]')!;
    expect(row).not.toBeNull();
    await act(async () => router.navigate('/review?hash=10&query=Tooltip'));
    await waitForReview();
    expect(host.querySelector('button[aria-label^="Open Tooltip 20,"]')).toBe(row);
    await act(async () => row.click());
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get('query')).toBe('Tooltip');
      expect(params.get('hash')).toBe('20');
      expect(host.querySelector('[aria-label="Selected change"] h2')?.textContent).toBe(
        'Tooltip 20',
      );
    });
  } finally {
    router.dispose();
  }
});

it('keeps the acknowledgment without reloading the bundle, then follows manual refreshes', async () => {
  await mount();
  expect(host.textContent).toContain('1 pending / 0 selected');
  await click('Select page');
  await push();
  await waitForPush();
  await waitForReview();
  // A push never reloads the bundle: CI/CDN lag would resurrect pre-save text.
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('0 pending / 0 selected');
  expect(host.textContent).toContain('Pushed 1 tooltip(s) to synthetic-test');
  const request = JSON.parse(post.mock.calls[0][0]!.body as string);
  expect(request).toEqual({ hashes: [10], expected: { 10: await publishableHash(tooltip) } });
  bundle.tooltips[10].text.en!.text = 'New saved content';
  await refresh();
  expect(host.textContent).toContain('1 pending / 0 selected');
  expect(host.textContent).toContain('New saved content');
  bundle.pushed[10] = await publishableHash(tooltip);
  await refresh();
  expect(useReviewSession.getState().acknowledgments).toEqual({});
  expect(host.textContent).toContain('1 pending / 0 selected');
  bundle.pushed[10] = await publishableHash(bundle.tooltips[10]);
  await refresh();
  expect(host.textContent).toContain('0 pending / 0 selected');
  // Once retired, the old local acknowledgment cannot hide a later authoritative marker.
  bundle.tooltips[10] = structuredClone(tooltip);
  await refresh();
  expect(host.textContent).toContain('1 pending / 0 selected');
});

it('selects pending changes from the sidebar and restores the selected item after returning', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  second.text.en!.text = 'Second saved edit';
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(host.textContent).toContain('2 pending / 0 selected'));
  expect(host.textContent).toContain('1 of 2');

  const sidebarLink = host.querySelector<HTMLAnchorElement>(
    '[aria-label="Pending saved changes"] a[href="/review?hash=20"]',
  );
  expect(sidebarLink).not.toBeNull();
  await act(async () => sidebarLink!.click());
  expect(host.textContent).toContain('2 of 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');

  await chooseWorkspace('/compendium');
  await chooseWorkspace('/review');
  await waitFor(() => expect(host.textContent).toContain('2 pending / 0 selected'));
  expect(host.textContent).toContain('2 of 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');
});

it('shows one anonymous notice, leads with friendly categories, and filters canonical IDs', async () => {
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
  await waitFor(() => expect(host.textContent).toContain('2 pending / 0 selected'));

  expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
  expect(host.textContent).not.toContain('Sign in to see latest change');
  expect(host.textContent).toContain('Friendly weapon traits');
  expect(host.textContent).toContain('weapon-trait');
  const weapon = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Open Weapon sample, Friendly weapon traits, 10"]',
  );
  expect(weapon?.textContent).toContain('#10');
  expect(host.querySelectorAll('[aria-label="Selected change"]')).toHaveLength(0);

  const category = host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
  await act(async () => {
    category.value = 'armor-perk';
    category.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(() => expect(host.textContent).toContain('1 of 1'));
  expect(host.textContent).toContain('Friendly armor effects');
  expect(
    host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Long sword perk, Friendly armor effects, 20"]',
    )?.textContent,
  ).toContain('#20');
  expect(
    host
      .querySelector<HTMLAnchorElement>(
        '[aria-label="Pending saved changes"] a[aria-current="page"]',
      )
      ?.getAttribute('href'),
  ).toContain('hash=20');

  await act(async () => useAuthStore.setState({ user }));
  await waitFor(() => expect(host.querySelectorAll('[role="note"]')).toHaveLength(0));
  await act(async () =>
    useAuthStore.setState({ user: null, loading: false, load: async () => {} }),
  );
  await waitFor(() => expect(host.querySelectorAll('[role="note"]')).toHaveLength(1));
});

it('retires acknowledgment when the bundle reports a superseding marker without catching up first', async () => {
  await mount();
  await click('Select page');
  await push();
  await waitForPush();
  await waitForReview();
  const other = structuredClone(tooltip);
  other.text.en!.text = 'Other live version';
  bundle.pushed[10] = await publishableHash(other);
  await refresh();
  expect(host.textContent).toContain('1 pending / 0 selected');
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('suspends pending-review window shortcuts while the Drafts popover is open and restores them on close', async () => {
  const second = structuredClone(tooltip);
  second.hash = 20;
  bundle.tooltips[20] = second;
  await mount();
  await waitFor(() => expect(host.textContent).toContain('2 pending / 0 selected'));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-drafts-button]')!.click());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(host.textContent).toContain('1 of 2');
  expect(host.textContent).toContain('2 pending / 0 selected');
  expect(post).not.toHaveBeenCalled();
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(host.textContent).toContain('2 of 2');
  expect(
    host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')?.textContent,
  ).toContain('Tooltip 20');
});

it('does not reload the bundle after a push, so success is never masked by a refresh', async () => {
  await mount();
  await click('Select page');
  await push();
  await waitForPush();
  expect(post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(loadBundle)).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('Cannot load editor data');
  expect(useReviewSession.getState().notice).toContain('Pushed 1');
  expect(useReviewSession.getState().error).toBeUndefined();
  expect(host.textContent).toContain('0 pending / 0 selected');
});

it('keeps partial-live error details and never acknowledges a failed publish', async () => {
  await mount();
  post.mockResolvedValueOnce(
    new Response('partial live write: liveCommit=synthetic; markers not recorded', { status: 502 }),
  );
  await click('Select page');
  await push();
  await waitForPush();
  expect(host.textContent).toContain(
    'partial live write: liveCommit=synthetic; markers not recorded',
  );
  expect(host.textContent).toContain('A failed push may have written live data');
  expect(host.textContent).toContain('1 pending / 1 selected');
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
  await click('Select page');
  await push();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(useReviewSession.getState().pushing).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => useAuthStore.setState({ user: { ...user, id: 2, login: 'other' } }));
  await mount();
  expect(button('Pushing...').disabled).toBe(true);
  await click('Select page');
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
  expect(host.textContent).toContain('0 pending / 0 selected');
  expect(post).toHaveBeenCalledTimes(1);
});

it('aborts before sending when unmounted or account changes during digest calculation', async () => {
  await mount();
  await click('Select page');
  await click('Push selected');
  await act(async () => {
    button('Push 1 live').click();
    useAuthStore.setState({ user: { ...user, role: 'translator' } });
  });
  await waitForPush();
  expect(post).not.toHaveBeenCalled();
  await act(async () => useAuthStore.setState({ user }));
  await click('Select page');
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
  await click('Select page');
  bundle.tooltips[10].text.en!.text = 'Unreviewed saved edit';
  await refresh();
  expect(host.textContent).toContain('1 pending / 0 selected');
  expect(button('Push selected').disabled).toBe(true);
  const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  button('Select page').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(post).not.toHaveBeenCalled();
});

it('does not submit if the saved snapshot changes while digests are being computed', async () => {
  await mount();
  await click('Select page');
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
  expect(host.textContent).toContain('1 pending / 0 selected');
});

it('retires acknowledgment when its tooltip is removed from the bundle', async () => {
  await mount();
  await click('Select page');
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
  await click('Select page');
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
  expect(host.textContent).toContain('2 pending / 2 selected');
  await click('Push selected');
  await act(async () =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  );
  expect(host.querySelector('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('confirms once: a double-click or held Enter cannot send a second push', async () => {
  await mount();
  await click('Select page');
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
  await waitFor(() => expect(host.textContent).toContain('121 pending'));
  // Select every page, then push all of them.
  while (!button('Next page').disabled) {
    await click('Select page');
    await click('Next page');
  }
  await click('Select page');
  expect(host.textContent).toContain('121 pending / 121 selected');
  expect(host.textContent).not.toContain('at most 100');
  expect(button('Push selected').disabled).toBe(false);
  await click('Push selected');
  expect(host.querySelectorAll('dialog li')).toHaveLength(121);
  await click('Push 121 live');
  await waitForPush();
  expect(JSON.parse(post.mock.calls[0][0]!.body as string).hashes).toHaveLength(121);
});
