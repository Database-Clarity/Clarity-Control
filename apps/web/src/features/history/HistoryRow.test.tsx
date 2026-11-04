// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { HistoryPanel } from './HistoryPanel';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { createRevisionCache } from './revisions';

const getHistory = vi.fn();
const getLegacyHistory = vi.fn();
vi.mock('../../services/legacyHistory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/legacyHistory')>()),
  getLegacyHistory: (...args: unknown[]) => getLegacyHistory(...args),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../../services/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/history')>()),
  getHistory: (...args: unknown[]) => getHistory(...args),
}));

const commit = (n: number) => ({
  commit: n.toString(16).padStart(40, '0'),
  author: 'Ann',
  date: '2026-10-27T00:00:00Z',
  message: `Edit ${n}`,
});
const tooltip: Tooltip = {
  hash: 10,
  associated: [],
  text: { en: { text: 'x', updatedAt: '2026-10-27T10:00:00Z', updatedBy: 'ann' } },
};
let host: HTMLDivElement;
let root: Root;
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getHistory.mockReset();
  getLegacyHistory.mockReset().mockResolvedValue(null);
  useDataStore.setState({
    data: {
      bundle: { tooltips: { 10: tooltip } },
      items: {},
      aliases: {},
      categories: [],
    } as unknown as EditorData,
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useAuthStore.setState({ user: { id: 1, login: 'ann', role: 'editor' } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDataStore.setState(originals.data);
  useAuthStore.setState(originals.auth);
  useDraftStore.setState(originals.drafts);
});

it('keeps the v2 count ready and loads legacy history only on open', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1), commit(2), commit(3)] });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(host.textContent ?? '').toMatch(/^History\s*Edited .* by ann, 3 revisions$/);
  expect(getHistory).toHaveBeenCalledTimes(1);
  expect(getLegacyHistory).not.toHaveBeenCalled();
  expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  // The commit list is not in the row until it is expanded.
  expect(host.querySelector('ol')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.querySelectorAll('ol li')).toHaveLength(3);
  await act(async () =>
    vi.waitFor(() => expect(getLegacyHistory).toHaveBeenCalledWith(10, expect.any(AbortSignal))),
  );
});

it('says 30+ when a full page of commits came back', async () => {
  getHistory.mockResolvedValue({
    page: 1,
    commits: Array.from({ length: 30 }, (_, i) => commit(i + 1)),
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.textContent).toContain('30+ revisions');
});

it('loads published text into a local draft while preserving current associations', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [] });
  const base = { ...tooltip, associated: [99] };
  useDataStore.setState({
    data: {
      ...useDataStore.getState().data!,
      bundle: { ...useDataStore.getState().data!.bundle, tooltips: { 10: base } },
    },
  });
  getLegacyHistory.mockResolvedValue({
    hash: 10,
    lanes: [
      {
        hash: 10,
        sourceHash: 10,
        verified: true,
        revisions: [{ ...commit(1), text: { en: 'Published old text' } }],
      },
    ],
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  const section = host.querySelector('section[aria-label="Published before migration"]')!;
  await act(async () => section.querySelector<HTMLButtonElement>('ol button')!.click());
  const click = async (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  await click('Restore this revision');
  expect(useDraftStore.getState().drafts[10]).toBeUndefined();
  await click('Load as draft');
  expect(useDraftStore.getState().drafts[10].next.text.en?.text).toBe('Published old text');
  expect(useDraftStore.getState().drafts[10].next.associated).toEqual([99]);
  expect(useDataStore.getState().data!.bundle.tooltips[10]).toEqual(base);
  expect(host.textContent).toContain('nothing was saved automatically');
});

it('does not ask the server when signed out, and says so when expanded', async () => {
  useAuthStore.setState({ user: null });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(getHistory).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Edited');
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.textContent).toContain('Sign in as a configured member');
  expect(host.textContent).not.toContain('No commits found');
});

it('skips legacy fetches for tooltips passed during fast navigation', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [] });
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<HistoryPanel hash={10} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(getLegacyHistory).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    getLegacyHistory.mockClear();
    for (const hash of [11, 12, 13, 14]) {
      await act(async () => {
        vi.advanceTimersByTime(30);
        root.render(<HistoryPanel hash={hash} />);
      });
    }
    expect(getLegacyHistory).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(150));
    expect(getLegacyHistory).toHaveBeenCalledTimes(1);
    expect(getLegacyHistory).toHaveBeenCalledWith(14, expect.any(AbortSignal));
  } finally {
    vi.useRealTimers();
  }
});

it('keeps v2 and legacy siblings distinct when the hash equals the cache identity', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [] });
  const hash = createRevisionCache(999).identity + 1;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await act(async () => root.render(<HistoryPanel hash={hash} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(errors.mock.calls.some((args) => String(args[0]).includes('same key'))).toBe(false);
    expect(host.querySelectorAll(`section[aria-label="History for ${hash}"]`)).toHaveLength(1);
    expect(host.querySelectorAll('section[aria-label="Published before migration"]')).toHaveLength(
      1,
    );
  } finally {
    errors.mockRestore();
  }
});

it('uses one list request across expansion and refreshes stale rows on reopening', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1)] });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
  await act(async () => toggle());
  expect(getHistory).toHaveBeenCalledTimes(1);
  await act(async () => toggle());
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  getHistory.mockResolvedValue({ page: 1, commits: [commit(2), commit(1)] });
  await act(async () => toggle());
  expect(host.querySelectorAll('ol li')).toHaveLength(2);
  expect(getHistory).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('shows subjects and spreads mounting a full cached page across frames', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  getHistory.mockResolvedValue({
    page: 1,
    commits: Array.from({ length: 30 }, (_, i) => ({
      ...commit(i + 1),
      message: `Subject ${i}\n\nA long commit body that belongs outside the row`,
    })),
  });
  try {
    await act(async () => root.render(<HistoryPanel hash={10} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(host.querySelectorAll('ol li > button')).toHaveLength(4);
    expect(host.textContent).not.toContain('A long commit body');
    while (frames.length) await act(async () => frames.shift()!(0));
    expect(host.querySelectorAll('ol li > button')).toHaveLength(30);
    expect(host.textContent).not.toContain('Preparing remaining revisions');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('refreshes the first page when saving advances bundle head after paging', async () => {
  let advanced = false;
  getHistory.mockImplementation((_hash: number, page: number) =>
    Promise.resolve({
      page,
      commits:
        page === 1
          ? Array.from({ length: 30 }, (_, i) => ({
              ...commit(advanced ? 100 - i : 90 - i),
              message: advanced && i === 0 ? 'NEW HEAD REVISION' : `old row ${i}`,
            }))
          : [commit(advanced ? 61 : 60)],
    }),
  );
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  const more = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Load more commits',
  )!;
  await act(async () => more.click());
  advanced = true;
  await act(async () => {
    const data = useDataStore.getState().data!;
    useDataStore.setState({
      data: { ...data, bundle: { ...data.bundle, sourceCommit: 'new-head' } },
    });
  });
  // The parent has refreshed page 1, so the new revision must be visible in its child list too.
  expect(getHistory.mock.calls.filter(([, p]) => p === 1)).toHaveLength(2);
  expect(host.textContent).toContain('NEW HEAD REVISION');
  expect(getHistory.mock.calls.filter(([, p]) => p === 2)).toHaveLength(1);
});
