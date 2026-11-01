// @vitest-environment jsdom
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

vi.mock('../../services/generator', () => ({ loadGenerator: vi.fn() }));
vi.mock('../../services/bundle', () => ({ loadBundle: vi.fn() }));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://synthetic.invalid',
  apiRequest: (path: string, init: RequestInit) => fetch(`https://synthetic.invalid${path}`, init),
}));
vi.mock('../../services/save/SavePanel', () => ({ SavePanel: () => null }));
vi.mock('../compendium/CompendiumBadge', () => ({ CompendiumBadge: () => null }));

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
  await flush();
}
beforeEach(async () => {
  useReviewSession.setState({
    acknowledgments: {},
    pushing: false,
    notice: undefined,
    error: undefined,
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  bundle = {
    sourceCommit: 'baseline',
    generatedAt: '2026-01-01T00:00:00Z',
    tooltips: { 10: structuredClone(tooltip) },
    pushed: {},
    permissions: { users: {} },
  };
  vi.mocked(loadGenerator).mockResolvedValue({ categories: [], items: {}, aliases: {} });
  vi.mocked(loadBundle).mockImplementation(async () => structuredClone(bundle));
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useAuthStore.setState({ user, loading: false, load: async () => {} });
  useDraftStore.setState({ hydrated: true, hydrate: async () => {}, drafts: {} });
  post = vi.fn(async () =>
    Response.json({
      commit: 'a'.repeat(40),
      liveCommit: 'b'.repeat(40),
      pushed: { 10: await publishableHash(tooltip) },
      branch: 'synthetic-test',
    }),
  );
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

it('keeps successful acknowledgment and notice through a real-store lagging refresh', async () => {
  await mount();
  expect(host.textContent).toContain('1 pending / 0 selected');
  let resolve!: (bundle: Bundle) => void;
  vi.mocked(loadBundle).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await click('Select page');
  await click('Push selected');
  expect(host.textContent).toContain('Loading manifest');
  await act(async () => resolve(structuredClone(bundle)));
  await flush();
  expect(post).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('0 pending / 0 selected');
  expect(host.textContent).toContain('Pushed 1 tooltip(s) to synthetic-test');
  const request = JSON.parse(post.mock.calls[0][0]!.body as string);
  expect(request).toEqual({ hashes: [10], expected: { 10: await publishableHash(tooltip) } });
  bundle.tooltips[10].text.en!.text = 'New saved content';
  await click('Refresh saved changes');
  expect(host.textContent).toContain('1 pending / 0 selected');
  expect(host.textContent).toContain('New saved content');
  bundle.pushed[10] = await publishableHash(tooltip);
  await click('Refresh saved changes');
  expect(useReviewSession.getState().acknowledgments).toEqual({});
  expect(host.textContent).toContain('1 pending / 0 selected');
  bundle.pushed[10] = await publishableHash(bundle.tooltips[10]);
  await click('Refresh saved changes');
  expect(host.textContent).toContain('0 pending / 0 selected');
  // Once retired, the old local acknowledgment cannot hide a later authoritative marker.
  bundle.tooltips[10] = structuredClone(tooltip);
  await click('Refresh saved changes');
  expect(host.textContent).toContain('1 pending / 0 selected');
});

it('retires acknowledgment when the bundle reports a superseding marker without catching up first', async () => {
  await mount();
  await click('Select page');
  await click('Push selected');
  const other = structuredClone(tooltip);
  other.text.en!.text = 'Other live version';
  bundle.pushed[10] = await publishableHash(other);
  await click('Refresh saved changes');
  expect(host.textContent).toContain('1 pending / 0 selected');
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('distinguishes failed refresh from failed push and preserves success on retry', async () => {
  await mount();
  vi.mocked(loadBundle).mockRejectedValueOnce(Error('synthetic bundle unavailable'));
  await click('Select page');
  await click('Push selected');
  expect(post).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Cannot load editor data: synthetic bundle unavailable');
  expect(useReviewSession.getState().notice).toContain('Pushed 1');
  expect(useReviewSession.getState().error).toBeUndefined();
  await click('Retry data loading');
  expect(host.textContent).toContain('Pushed 1');
  expect(host.textContent).toContain('0 pending / 0 selected');
});

it('keeps partial-live error details and never acknowledges a failed publish', async () => {
  await mount();
  post.mockResolvedValueOnce(
    new Response('partial live write: liveCommit=synthetic; markers not recorded', { status: 502 }),
  );
  await click('Select page');
  await click('Push selected');
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
  await click('Push selected');
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
  await flush();
  expect(useReviewSession.getState().pushing).toBe(false);
  expect(useReviewSession.getState().notice).toBeUndefined();
  expect(host.textContent).toContain('0 pending / 0 selected');
  expect(post).toHaveBeenCalledTimes(1);
});

it('aborts before sending when unmounted or account changes during digest calculation', async () => {
  await mount();
  await click('Select page');
  await act(async () => {
    button('Push selected').click();
    useAuthStore.setState({ user: { ...user, role: 'translator' } });
  });
  await flush();
  expect(post).not.toHaveBeenCalled();
  await act(async () => useAuthStore.setState({ user }));
  await click('Select page');
  await act(async () => {
    button('Push selected').click();
    root.unmount();
  });
  root = createRoot(host);
  await flush();
  expect(post).not.toHaveBeenCalled();
  expect(useReviewSession.getState().pushing).toBe(false);
});

it('clears reviewed selection on refresh and leaves keyboard events in controls alone', async () => {
  await mount();
  await click('Select page');
  bundle.tooltips[10].text.en!.text = 'Unreviewed saved edit';
  await click('Refresh saved changes');
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
  await act(async () => {
    button('Push selected').click();
    const data = useDataStore.getState().data!;
    const newer = structuredClone(data);
    newer.bundle.tooltips[10].text.en!.text = 'Unreviewed concurrent save';
    useDataStore.setState({ data: newer });
  });
  await flush();
  expect(post).not.toHaveBeenCalled();
  expect(useReviewSession.getState().pushing).toBe(false);
  expect(host.textContent).toContain('1 pending / 0 selected');
});

it('retires acknowledgment when its tooltip is removed from the bundle', async () => {
  await mount();
  await click('Select page');
  await click('Push selected');
  expect(Object.keys(useReviewSession.getState().acknowledgments)).toEqual(['10']);
  bundle.tooltips = {};
  await click('Refresh saved changes');
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});
