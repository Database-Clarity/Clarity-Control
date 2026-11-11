// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { HistoryPanel } from './HistoryPanel';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

const getHistory = vi.fn();
const getVersion = vi.fn();
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../../services/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/history')>()),
  getHistory: (...args: unknown[]) => getHistory(...args),
  getVersion: (...args: unknown[]) => getVersion(...args),
}));

const id = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number) => ({
  commit: id(n),
  author: 'Ann',
  date: '2026-10-27T00:00:00Z',
  message: `Edit ${n}`,
});
const stamp = { updatedAt: '2026-10-27T10:00:00Z', updatedBy: 'ann' };
const revision = (en: string, fr?: string): Tooltip => ({
  hash: 10,
  associated: [],
  text: {
    en: { text: en, ...stamp },
    ...(fr === undefined ? {} : { fr: { text: fr, ...stamp } }),
  },
});
const versions: Record<string, Tooltip> = {
  [id(1)]: revision('one'),
  [id(2)]: revision('one two', 'un'),
  [id(3)]: revision('one two three', 'un deux'),
};
const base = revision('current text', 'courant');
let host: HTMLDivElement;
let root: Root;
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
};
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const entries = () => [...host.querySelectorAll<HTMLButtonElement>('ol li > button')];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getHistory.mockReset();
  getVersion.mockReset();
  getHistory.mockResolvedValue({ page: 1, commits: [commit(3), commit(2), commit(1)] });
  getVersion.mockImplementation((_hash: number, sha: string) =>
    Promise.resolve({ commit: sha, tooltip: versions[sha] }),
  );
  useDataStore.setState({
    data: {
      bundle: { tooltips: { 10: base } },
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
  await act(async () => root.render(<HistoryPanel hash={10} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDataStore.setState(originals.data);
  useAuthStore.setState(originals.auth);
  useDraftStore.setState(originals.drafts);
});

it('opens on hover with that revision diffed against its predecessor, per language', async () => {
  expect(dialog()).toBeNull();
  await act(async () => {
    entries()[0].parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    entries()[0].parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
  });
  await wait(260);
  expect(dialog()).not.toBeNull();
  // Revision 3 against revision 2: only " three" is new in English, " deux" in French.
  expect(dialog()!.querySelector('ins')!.textContent).toBe(' three');
  expect(dialog()!.textContent).not.toContain('French');
  expect(dialog()!.querySelectorAll('ins')).toHaveLength(1);
  expect(dialog()!.querySelector('pre')).toBeNull();
  // The popover floats: it is not inside the list's flow.
  expect(dialog()!.style.left).not.toBe('');
  expect(dialog()!.style.top).not.toBe('');
});

it('waits for click after pointer focus instead of opening twice', async () => {
  await act(async () => {
    entries()[1].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    entries()[1].focus();
  });
  expect(dialog()).toBeNull();
  await act(async () => entries()[1].click());
  expect(dialog()).not.toBeNull();
  expect(entries()[1].getAttribute('aria-expanded')).toBe('true');
});

it('is keyboard reachable: focus opens it and Esc closes it and keeps focus on the entry', async () => {
  await act(async () => entries()[1].focus());
  await wait(0);
  expect(dialog()).not.toBeNull();
  expect(entries()[1].getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(entries()[1]);
});

it('positions from ResizeObserver sizes without synchronously measuring the new diff', async () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => {
    throw new Error('Synchronous popover height read');
  });
  const row = entries()[0].parentElement!;
  const bounds = vi
    .spyOn(row, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(100, 600, 200, 50));
  try {
    await act(async () => entries()[0].click());
    expect(bounds).toHaveBeenCalled();
    await act(async () =>
      observers[0](
        [
          {
            target: dialog(),
            borderBoxSize: [{ blockSize: 300.4 }],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    expect(dialog()!.style.top).toBe(`${window.innerHeight - 300 - 8}px`);
    expect(dialog()!.style.left).toBe('306px');
    bounds.mockReturnValue(new DOMRect(100, 200, 200, 50));
    await act(async () =>
      observers[0](
        [
          {
            target: row.parentElement,
            borderBoxSize: [{ blockSize: 1000 }],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    expect(dialog()!.style.top).toBe('200px');
    expect(height).not.toHaveBeenCalled();
  } finally {
    height.mockRestore();
    bounds.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('click pins it past mouse leave; a press outside closes it', async () => {
  await act(async () => entries()[0].click());
  expect(dialog()).not.toBeNull();
  await act(async () => {
    entries()[0].parentElement!.dispatchEvent(new MouseEvent('mouseleave'));
  });
  await wait(260);
  expect(dialog()).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(dialog()).toBeNull();
});

it('cancels pending hover on a closed row when another revision is pinned', async () => {
  await act(async () => {
    entries()[0].parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => entries()[1].click());
  await wait(260);
  expect(entries()[0].getAttribute('aria-expanded')).toBe('false');
  expect(entries()[1].getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
});

it('the first revision is shown as all new, and the cache means one request per commit', async () => {
  await act(async () => entries()[2].click());
  await wait(0);
  expect(dialog()!.textContent).toContain('First revision');
  await act(async () => entries()[2].click());
  expect(dialog()).toBeNull();
  await act(async () => entries()[2].click());
  await act(async () => entries()[1].click());
  await wait(0);
  // Revisions 1 and 2 were each fetched once however often they were opened.
  expect(getVersion.mock.calls.filter(([, sha]) => sha === id(1))).toHaveLength(1);
  expect(getVersion.mock.calls.filter(([, sha]) => sha === id(2))).toHaveLength(1);
});

it('compares with the current draft from inside the popover', async () => {
  await act(async () => entries()[0].click());
  await wait(0);
  const compare = [...dialog()!.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('vs current draft'),
  )!;
  await act(async () => compare.click());
  expect(compare.getAttribute('aria-pressed')).toBe('true');
  expect(dialog()!.textContent).not.toContain('courant');
});

it('restores inside the popover after confirming, and never offers it on a read-only page', async () => {
  await act(async () => entries()[1].click());
  await wait(0);
  const button = (label: string) =>
    [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === label);
  await act(async () => button('Restore this revision')!.click());
  expect(useDraftStore.getState().drafts[10]).toBeUndefined();
  await act(async () => button('Load as draft')!.click());
  expect(useDraftStore.getState().drafts[10]?.next.text.en?.text).toBe('one two');
  expect(dialog()).toBeNull();
  expect(host.textContent).toContain('loaded as a local draft');
  await act(async () => root.render(<HistoryPanel hash={10} readOnly />));
  await act(async () => entries()[1].click());
  await wait(0);
  expect(button('Restore this revision')).toBeUndefined();
});

it('keeps the translator rule: a note, and only assigned languages are restored', async () => {
  await act(async () => {
    useAuthStore.setState({
      user: { id: 2, login: 'tess', role: 'translator', languages: ['fr'] },
    });
    root.render(<HistoryPanel hash={10} language="fr" />);
  });
  await wait(0);
  await act(async () => entries()[1].click());
  await wait(0);
  expect(dialog()!.textContent).toContain('only the shown, assigned translation language');
  const button = (label: string) =>
    [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button('Restore this revision').click());
  await act(async () => button('Load as draft').click());
  const next = useDraftStore.getState().drafts[10]?.next;
  expect(next?.text.fr?.text).toBe('un');
  expect(next?.text.en?.text).toBe('current text');
});

it('Esc from inside the popover closes it for good, not reopened by the returning focus', async () => {
  await act(async () => entries()[0].focus());
  await wait(0);
  const inside = dialog()!.querySelector<HTMLButtonElement>('button')!;
  await act(async () => inside.focus());
  await act(async () => {
    inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await wait(0);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(entries()[0]);
});

it('shows one popover at a time and keeps links out of the trigger button', async () => {
  await act(async () => entries()[0].click());
  await act(async () => entries()[1].click());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(host.querySelector('ol button a')).toBeNull();
  await wait(0);
  const compare = [...dialog()!.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('vs current draft'),
  )!;
  expect(compare.getAttribute('aria-pressed')).toBe('false');
});

it('shows restored and deleted revisions without retrying immutable file absence', async () => {
  getVersion.mockImplementation((_hash: number, sha: string) =>
    sha === id(2)
      ? Promise.reject(new Error('API HTTP 404: {"error":"Tooltip did not exist at that commit"}'))
      : Promise.resolve({ commit: sha, tooltip: versions[sha] }),
  );
  getVersion.mockClear();
  await act(async () =>
    useAuthStore.setState({ user: { id: 10, login: 'delete-test', role: 'editor' } }),
  );
  await act(async () => entries()[0].click());
  await wait(0);
  expect(dialog()!.textContent).toContain('Restored in this revision.');
  expect(dialog()!.textContent).not.toContain('Retry');
  await act(async () => entries()[1].click());
  await wait(0);
  expect(dialog()!.textContent).toContain('Deleted in this revision.');
  expect(dialog()!.textContent).not.toContain('Restore this revision');
  expect(dialog()!.querySelector('del')!.textContent).toContain('one');
  await act(async () => entries()[0].click());
  await wait(0);
  expect(getVersion.mock.calls.filter(([, sha]) => sha === id(2))).toHaveLength(1);
});

describe('phone placement', () => {
  let phone = true;
  const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 772, width: 390 });
  beforeEach(() => {
    phone = true;
    viewport.height = 772;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('700px') ? phone : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 772);
    vi.stubGlobal('innerWidth', 390);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows the visual viewport (an iOS keyboard) while open', async () => {
    await act(async () => entries()[1].focus());
    await wait(0);
    const before = dialog()!.style.maxHeight;
    viewport.height = 300;
    await act(async () => void viewport.dispatchEvent(new Event('resize')));
    expect(dialog()!.style.maxHeight).not.toBe(before);
    expect(parseFloat(dialog()!.style.maxHeight)).toBeLessThanOrEqual(300);
  });

  it('drops the phone bottom anchor when the layout turns desktop', async () => {
    await act(async () => entries()[1].focus());
    await wait(0);
    dialog()!.style.bottom = '172px';
    phone = false;
    await act(async () => void window.dispatchEvent(new Event('resize')));
    expect(dialog()!.style.bottom).toBe('auto');
  });
});

it('filters against original parents and resets popovers when the language or role changes', async () => {
  getHistory.mockResolvedValue({
    commits: [commit(5), commit(4), commit(3), commit(2), commit(1)],
  });
  const scoped = {
    [id(1)]: revision('one'),
    [id(2)]: revision('one', 'un'), // hidden French-only revision
    [id(3)]: revision('two', 'un'),
    [id(4)]: revision('two', 'deux'), // hidden French-only revision
    [id(5)]: { ...revision('two', 'deux'), associated: [20] },
  };
  getVersion.mockImplementation((_hash: number, sha: string) =>
    Promise.resolve({ tooltip: scoped[sha] }),
  );
  await act(async () => {
    useAuthStore.setState({ user: { id: 4, login: 'new', role: 'maintainer' } });
  });
  await wait(100);
  expect(entries().map((button) => button.textContent)).toEqual([
    expect.stringContaining('Edit 5'),
    expect.stringContaining('Edit 3'),
    expect.stringContaining('Edit 1'),
  ]);
  expect(host.textContent).toContain('2 changes outside this view hidden');
  await act(async () => entries()[1].click());
  await wait(0);
  expect(dialog()!.textContent).not.toContain('French');
  await act(async () => root.render(<HistoryPanel hash={10} language="fr" />));
  await wait(100);
  expect(dialog()).toBeNull();
  expect(entries()).toHaveLength(5);
  expect(host.querySelector('[aria-label="Published before migration"]')).toBeNull();
  await act(async () => entries()[1].click());
  await wait(0);
  expect(dialog()!.textContent).toContain('French');
  await act(async () => useAuthStore.setState({ user: null }));
  expect(dialog()).toBeNull();
  expect(entries()).toHaveLength(0);
});

it('keeps a portaled popover open for its own pointer events and closes on outside presses', async () => {
  await act(async () => entries()[0].click());
  await wait(0);
  expect(dialog()!.parentElement).toBe(document.body);
  await act(async () => dialog()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(dialog()).not.toBeNull();
  await act(async () =>
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
  );
  expect(dialog()).toBeNull();
});
