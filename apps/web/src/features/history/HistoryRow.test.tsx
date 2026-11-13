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
import { skeletonMinimumMs } from '../../ui/Skeleton';

const getHistory = vi.fn();
const getVersion = vi.fn();
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
  getVersion: (...args: unknown[]) => getVersion(...args),
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
// The skeleton minimum counts from its first painted frame, so allow a few frames on top.
const paintRows = () =>
  act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(skeletonMinimumMs + 60);
    else await new Promise((resolve) => setTimeout(resolve, skeletonMinimumMs + 60));
  });
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getHistory.mockReset();
  getVersion.mockReset();
  getVersion.mockImplementation((_hash: number, sha: string) =>
    Promise.resolve({ tooltip: { ...tooltip, text: { en: { ...tooltip.text.en!, text: sha } } } }),
  );
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

it('keeps English legacy upload attribution when migrated edit timestamps are unknown', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [] });
  const migrated: Tooltip = {
    ...tooltip,
    text: {
      en: { ...tooltip.text.en!, updatedAt: '1970-01-01T00:00:00Z', updatedBy: '' },
      fr: { ...tooltip.text.en!, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'hidden-fr-author' },
    },
    legacy: { lastUpload: Date.parse('2025-01-01T00:00:00Z'), uploadedBy: 'legacy-uploader' },
  };
  useDataStore.setState((state) => ({
    data: { ...state.data!, bundle: { ...state.data!.bundle, tooltips: { 10: migrated } } },
  }));
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(host.textContent).toContain('by legacy-uploader');
  expect(host.textContent).not.toContain('hidden-fr-author');
  expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2025-01-01T00:00:00.000Z');
  expect(getVersion).not.toHaveBeenCalled();
});

it('keeps the v2 count ready and loads legacy history only on open', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1), commit(2), commit(3)] });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
  expect(host.textContent ?? '').toMatch(/^History\s*Edited .* by ann$/);
  expect(getVersion).not.toHaveBeenCalled();
  expect(getHistory).toHaveBeenCalledTimes(1);
  expect(getLegacyHistory).not.toHaveBeenCalled();
  expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  // The commit list is not in the row until it is expanded.
  expect(host.querySelector('ol')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  expect(host.querySelectorAll('ol li')).toHaveLength(3);
  await act(async () =>
    vi.waitFor(() => expect(getLegacyHistory).toHaveBeenCalledWith(10, expect.any(AbortSignal))),
  );
});

it('shows the open language attribution inside the row, only once expanded', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1)] });
  await act(async () =>
    root.render(<HistoryPanel hash={10} attribution={<p data-attribution="">Edited by ann</p>} />),
  );
  expect(host.querySelector('[data-attribution]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  const attribution = host.querySelector('[data-attribution]')!;
  expect(attribution.textContent).toBe('Edited by ann');
  // Above the commit list.
  expect(
    attribution.compareDocumentPosition(host.querySelector('ol')!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('says 30+ when a full page of commits came back', async () => {
  getHistory.mockResolvedValue({
    page: 1,
    commits: Array.from({ length: 30 }, (_, i) => commit(i + 1)),
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  expect(host.textContent).not.toContain('30+ revisions');
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
  await paintRows();
  const section = host.querySelector('section[aria-label="Published before migration"]')!;
  await act(async () => section.querySelector<HTMLButtonElement>('ol button')!.click());
  const click = async (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(
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
  await paintRows();
  expect(host.textContent).toContain('Sign in as a configured member');
  expect(host.textContent).not.toContain('No commits found');
});

it('skips legacy fetches for tooltips passed during fast navigation', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [] });
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<HistoryPanel hash={10} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await paintRows();
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
    await paintRows();
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
  await paintRows();
  expect(getHistory).toHaveBeenCalledTimes(1);
  await act(async () => toggle());
  await paintRows();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  getHistory.mockResolvedValue({ page: 1, commits: [commit(2), commit(1)] });
  await act(async () => toggle());
  await paintRows();
  expect(host.querySelectorAll('ol li')).toHaveLength(2);
  expect(getHistory).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('renders only a bounded visible group and advances on request', async () => {
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
    // The skeletons' first paint.
    await act(async () => frames.splice(0).forEach((callback) => callback(0)));
    await paintRows();
    expect(host.querySelectorAll('ol li > button')).toHaveLength(8);
    expect(host.textContent).not.toContain('A long commit body');
    while (frames.length) await act(async () => frames.shift()!(0));
    expect(host.querySelectorAll('ol li > button')).toHaveLength(8);
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show older revisions')!
        .click(),
    );
    expect(host.querySelectorAll('ol li > button')).toHaveLength(16);
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
  await paintRows();
  // Advancing the visible range requests the next API page near its boundary.
  for (let index = 0; index < 3; index++) {
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show older revisions')!
        .click(),
    );
  }
  advanced = true;
  await act(async () => {
    const data = useDataStore.getState().data!;
    useDataStore.setState({
      data: { ...data, bundle: { ...data.bundle, sourceCommit: 'new-head' } },
    });
  });
  await paintRows();
  // The parent has refreshed page 1, so the new revision must be visible in its child list too.
  expect(getHistory.mock.calls.filter(([, p]) => p === 1)).toHaveLength(2);
  expect(host.textContent).toContain('NEW HEAD REVISION');
  // Scope classification needs the next page's first revision as the final row's parent.
  expect(getHistory.mock.calls.filter(([, p]) => p === 2)).toHaveLength(1);
});

it('keeps an expanded history row open while cancelling suspended requests', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1)] });
  getHistory.mockImplementationOnce(
    (_hash: number, _page: number, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  const signal = getHistory.mock.calls[0][2] as AbortSignal;
  getHistory.mockClear();
  await act(async () => root.render(<HistoryPanel hash={10} suspended />));
  expect(host.querySelector('button[aria-expanded=true]')).not.toBeNull();
  expect(signal.aborted).toBe(true);
  expect(getHistory).not.toHaveBeenCalled();
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(host.querySelector('button[aria-expanded=true]')).not.toBeNull();
  await paintRows();
  expect(host.querySelectorAll('ol li')).toHaveLength(1);
});

it('does not fetch bodies while collapsed, and shows only classified scoped revisions', async () => {
  getHistory.mockResolvedValue({ commits: [commit(3), commit(2), commit(1)] });
  getVersion.mockImplementation((_hash: number, sha: string) =>
    Promise.resolve({
      tooltip: {
        ...tooltip,
        text: {
          en: { ...tooltip.text.en!, text: sha === commit(3).commit ? 'two' : 'one' },
          ...(sha !== commit(1).commit ? { fr: { ...tooltip.text.en!, text: 'un' } } : {}),
        },
      },
    }),
  );
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
  expect(host.textContent).not.toContain('revisions');
  expect(getVersion).not.toHaveBeenCalled();
  expect(host.querySelector('ol')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  expect(host.querySelectorAll('ol li > button')).toHaveLength(2);
  expect(host.textContent).toContain('1 change hidden in this view');
});

it('shows sized skeletons and cancels active and queued fallback bodies on close', async () => {
  const signals: AbortSignal[] = [];
  getHistory.mockResolvedValue({
    commits: Array.from({ length: 30 }, (_, index) => commit(30 - index)),
  });
  getVersion.mockImplementation((_hash: number, _sha: string, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(getVersion).not.toHaveBeenCalled();
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
  await act(async () => toggle());
  await paintRows();
  expect(host.querySelectorAll('[data-history-pending]')).toHaveLength(8);
  expect(host.querySelector('ol')!.getAttribute('aria-busy')).toBe('true');
  expect(host.querySelector('ol li > button')).toBeNull();
  expect(host.textContent).not.toContain('hidden in this view');
  expect(signals).toHaveLength(4);
  await act(async () => toggle());
  await paintRows();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(getVersion).toHaveBeenCalledTimes(4);
});

it('uses batch hints without bodies and bounds fallback work to the visible group plus one ahead', async () => {
  getHistory.mockResolvedValue({
    commits: Array.from({ length: 30 }, (_, index) => ({
      ...commit(30 - index),
      message: `Hint\n\nClarity-Changed: 10=${index % 2 ? 'de' : 'en'};99=fr`,
    })),
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  expect(getVersion).not.toHaveBeenCalled();
  expect(host.querySelectorAll('ol li > button')).toHaveLength(4);
  expect(host.textContent).toContain('4 changes hidden in this view');
  expect(host.querySelector('ol')!.getAttribute('aria-busy')).toBe('false');
  expect(host.textContent).not.toContain('30 revisions');
});

it('requires scrolling to advance an intersecting sentinel, rather than draining history eagerly', async () => {
  const observers = new Set<(entries: { isIntersecting: boolean }[]) => void>();
  let scrollRoot: Element | null = null;
  class Observer {
    constructor(
      private callback: (entries: { isIntersecting: boolean }[]) => void,
      options: { root: Element },
    ) {
      observers.add(callback);
      scrollRoot = options.root;
    }
    observe() {}
    disconnect() {
      observers.delete(this.callback);
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  try {
    getHistory.mockResolvedValue({
      commits: Array.from({ length: 30 }, (_, index) => ({
        ...commit(30 - index),
        message: 'Hint\n\nClarity-Changed: 10=en',
      })),
    });
    await act(async () => root.render(<HistoryPanel hash={10} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await paintRows();
    await act(async () =>
      [...observers].forEach((callback) => callback([{ isIntersecting: true }])),
    );
    expect(host.querySelectorAll('ol li > button')).toHaveLength(8);
    await act(async () => scrollRoot!.dispatchEvent(new Event('scroll')));
    expect(host.querySelectorAll('ol li > button')).toHaveLength(16);
    await act(async () =>
      [...observers].forEach((callback) => callback([{ isIntersecting: true }])),
    );
    expect(host.querySelectorAll('ol li > button')).toHaveLength(16);
    expect(getVersion).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps fallback skeletons visible for the shared minimum after classification finishes', async () => {
  vi.useFakeTimers();
  try {
    getHistory.mockResolvedValue({ commits: [commit(1)] });
    await act(async () => root.render(<HistoryPanel hash={10} />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    });
    expect(host.querySelector('[data-history-pending]')).not.toBeNull();
    expect(host.querySelector('ol li > button')).toBeNull();
    // The minimum starts once the skeleton's first frame has painted.
    await act(async () => vi.advanceTimersToNextFrame());
    await act(async () => vi.advanceTimersByTimeAsync(1)); // The post-paint stamp task.
    await act(async () => vi.advanceTimersByTimeAsync(skeletonMinimumMs - 1));
    expect(host.querySelector('ol li > button')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.querySelector('ol li > button')).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('renders trailer hints immediately when metadata arrives after opening', async () => {
  let resolve!: (value: unknown) => void;
  getHistory.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
  });
  await act(async () =>
    resolve({ commits: [{ ...commit(1), message: 'Hint\n\nClarity-Changed: 10=en' }] }),
  );
  expect(host.querySelector('ol li > button')).not.toBeNull();
  expect(host.querySelector('[data-history-pending]')).toBeNull();
  expect(getVersion).not.toHaveBeenCalled();
});

it('keeps loaded commits mounted while a later API page is pending', async () => {
  let resolvePage!: (value: { page: number; commits: ReturnType<typeof commit>[] }) => void;
  const nextPage = new Promise<{ page: number; commits: ReturnType<typeof commit>[] }>(
    (resolve) => {
      resolvePage = resolve;
    },
  );
  getHistory.mockImplementation((_hash: number, page: number) =>
    page === 1
      ? Promise.resolve({
          page: 1,
          commits: Array.from({ length: 30 }, (_, index) => ({
            ...commit(100 - index),
            message: `Loaded ${index}\n\nClarity-Changed: 10=en`,
          })),
        })
      : nextPage,
  );
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  await paintRows();
  const first = host.querySelector('ol li > button');
  for (let index = 0; index < 3; index++) {
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show older revisions')!
        .click(),
    );
  }
  expect(getHistory.mock.calls.some(([, page]) => page === 2)).toBe(true);
  expect(host.querySelector('ol')!.hidden).toBe(false);
  expect(host.querySelector('ol li > button')).toBe(first);
  expect(host.querySelectorAll('ol li > button')).toHaveLength(30);
  await act(async () =>
    resolvePage({
      page: 2,
      commits: [{ ...commit(50), message: 'Next page\n\nClarity-Changed: 10=en' }],
    }),
  );
  await paintRows();
  expect(host.querySelector('ol li > button')).toBe(first);
  expect(host.querySelectorAll('ol li > button')).toHaveLength(31);
});
