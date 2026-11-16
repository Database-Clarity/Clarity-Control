// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipNavigation } from '../navigation/TooltipNavigation';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';
import { useDataStore, type EditorData } from '../../stores/data';
import { useSavedWorklists } from './worklists';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import { resetWorkQueues, useWorkQueues } from './store';
import { startQueue } from './start';
import { usePreviewReviewStore } from '../../stores/previewReview';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: api }));
const data: EditorData = {
  items: Object.fromEntries(
    [11, 12, 13].map((hash) => [
      hash,
      { hash, name: `Entry ${hash}`, icon: '', categoryId: 'perks', inGameDescription: '' },
    ]),
  ),
  aliases: {},
  categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
  bundle: {
    tooltips: {},
    sourceCommit: 'fixture',
    generatedAt: '',
    permissions: { users: {} },
    pushed: {},
  },
};
let host: HTMLDivElement, root: Root;
const sessionToken = `${btoa(JSON.stringify({ exp: 4102444800 }))}.test`;
beforeEach(async () => {
  vi.useFakeTimers();
  let row: { id: string; name: string; hashes: number[] } | null = null;
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/worklists')
      return Response.json({
        lists: row
          ? [
              {
                id: row.id,
                name: row.name,
                count: row.hashes.length,
                revision: 'a'.repeat(32),
                updatedAt: 1,
              },
            ]
          : [],
      });
    if (init?.method === 'PUT') {
      const { op } = JSON.parse(String(init.body));
      row = { id: path.split('/').at(-1)!, name: op.name, hashes: op.hashes };
    }
    return Response.json({ worklist: row, revision: row ? 'a'.repeat(32) : null });
  });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  sessionStorage.setItem('clarity-editor-session', sessionToken);
  useAuthStore.setState({
    user: { id: 1, login: 'one', role: 'editor' } as User,
    loading: false,
    token: sessionToken,
  });
  useSavedWorklists.setState({
    scope: '1',
    saving: [],
    failed: [],
    lists: [],

    index: {},
    loaded: [],
  });
  setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [12] }));
  useDataStore.setState({ data });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/t/11']}>
        <TooltipNavigation data={data} />
      </MemoryRouter>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Let after-paint work queued by this test finish before the next one starts.
  act(() => vi.runAllTimers());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setEditorDraftFetch(undefined);
  resetWorkQueues();
  usePreviewReviewStore.setState({ host: null, entries: {}, prompt: null });
});
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
/** Opens the finder and lets the open frame paint, after which the worklist bar fills in. */
async function openFinder() {
  await act(async () => field().click());
  await act(async () => {
    vi.advanceTimersByTime(50);
  });
}
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )!;
async function press(key: string, ctrlKey = false) {
  await act(async () => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }),
    );
  });
}
function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('selects finder rows by keyboard and saves the frozen selection with inline naming', async () => {
  await openFinder();
  await press(' ', true);
  await press('ArrowDown');
  await press(' ', true);
  await press('Enter', true);
  expect(host.querySelector('section[aria-label="Add finder entries to worklist"]')).not.toBeNull();
  fill('New worklist name', 'Finder list');
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([11, 12]);
  expect(field().getAttribute('aria-expanded')).toBe('true');
});
it('selects one entry with a row click, and Cancel keeps the finder open', async () => {
  await openFinder();
  await act(async () => button('Select entries').click());
  const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.querySelector('input[aria-label="Select Entry 12 for worklist"]'),
  )!;
  await act(async () => row.click());
  expect(host.querySelector('[role="option"] input:checked')).not.toBeNull();
  expect(field().getAttribute('aria-expanded')).toBe('true');
  await act(async () => button('Add 1 to worklist').click());
  expect(host.querySelector('form')).not.toBeNull();
  await act(async () => button('Cancel').click());
  expect(host.querySelector('form')).toBeNull();
  expect(field().getAttribute('aria-expanded')).toBe('true');
  expect(useSavedWorklists.getState().lists).toEqual([]);
});
it("opens a category's Drafts worklist from the finder using the shared queue", async () => {
  await openFinder();
  await act(async () => button('Drafts worklists').click());
  // Escape and Cancel return to the bar with the finder still open.
  await act(async () => button('Cancel').click());
  expect(field().getAttribute('aria-expanded')).toBe('true');
  await act(async () => button('Drafts worklists').click());
  await act(async () => button('Drafts · Perks1').click());
  const store = useWorkQueues.getState();
  expect(store.queues[store.active!]!.source).toBe('drafts');
  expect(store.queues[store.active!]!.items.map((item) => item.hash)).toEqual([12]);
  expect(store.queues[store.active!]!.origin.restore).toEqual({ category: 'perks' });
});

it('keeps the original run and finder when preview review refuses Drafts opening repeatedly', async () => {
  const first = { key: '11', hash: 11, name: 'Entry 11' };
  startQueue({
    source: 'custom',
    scope: 'shown',
    items: [first],
    first,
    origin: { path: '/', restore: {} },
  });
  const before = JSON.stringify(useWorkQueues.getState());
  const session = sessionStorage.getItem('clarity-work-through:v1');
  usePreviewReviewStore.setState({
    host: { show: vi.fn() },
    entries: { 11: { canonical: 11, dirty: 2, reviewed: 1 } },
    prompt: null,
  });
  await openFinder();
  await act(async () => button('Drafts worklists').click());
  for (let attempt = 0; attempt < 6; attempt++) {
    await act(async () => button('Drafts · Perks1').click());
  }
  expect(usePreviewReviewStore.getState().prompt).toBe(11);
  expect(JSON.stringify(useWorkQueues.getState())).toBe(before);
  expect(sessionStorage.getItem('clarity-work-through:v1')).toBe(session);
  expect(field().getAttribute('aria-expanded')).toBe('true');
});

it('keeps the multi-selection when cancelling a target, and freezes it while choosing', async () => {
  await openFinder();
  await press(' ', true);
  await press('ArrowDown');
  await press(' ', true);
  await press('Enter', true);
  await press(' ', true);
  await act(async () => button('Cancel').click());
  expect(button('Add 2 to worklist')).toBeDefined();
  expect(host.querySelectorAll('input[data-worklist-check]:checked')).toHaveLength(2);
  expect(useSavedWorklists.getState().lists).toEqual([]);
});

it('keeps worklist row controls unmounted until selection starts', async () => {
  await act(async () => field().click());
  // The open frame draws the bar's box only; its controls follow once that frame has painted.
  expect(host.querySelector('[aria-label="Finder worklists"]')!.querySelector('button')).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(50);
  });
  expect(host.querySelector('input[data-worklist-check]')).toBeNull();
  await act(async () => button('Select entries').click());
  expect(host.querySelectorAll('input[data-worklist-check]').length).toBeGreaterThan(0);
  await act(async () => button('Done').click());
  expect(host.querySelector('input[data-worklist-check]')).toBeNull();
  await press('Escape');
  await openFinder();
  await press(' ', true);
  expect(host.querySelector('input[data-worklist-check]:checked')).not.toBeNull();
});
