// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipNavigation } from '../navigation/TooltipNavigation';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';
import type { EditorData } from '../../stores/data';
import { useSavedWorklists } from './worklists';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import { resetWorkQueues, useWorkQueues } from './store';
import { startQueue } from './start';
import { usePreviewReviewStore } from '../../stores/previewReview';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
beforeEach(async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  useAuthStore.setState({
    user: { id: 1, login: 'one', role: 'editor' } as User,
    loading: false,
    token: null,
  });
  useSavedWorklists.setState({
    scope: '1',
    lists: [],
    base: [],
    ops: [],
    recovery: [],
    blocked: null,
    index: {},
    loaded: [],
    pending: false,
  });
  setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [12] }));
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setEditorDraftFetch(undefined);
  resetWorkQueues();
  usePreviewReviewStore.setState({ host: null, entries: {}, prompt: null });
});
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
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
  await act(async () => field().click());
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
it('adds one entry from its row action, and Cancel keeps the finder open', async () => {
  await act(async () => field().click());
  const add = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Add Entry 12 to worklist"]',
  )!;
  await act(async () => add.click());
  expect(host.querySelector('form')).not.toBeNull();
  await act(async () => button('Cancel').click());
  expect(host.querySelector('form')).toBeNull();
  expect(field().getAttribute('aria-expanded')).toBe('true');
  expect(useSavedWorklists.getState().lists).toEqual([]);
});
it('opens built-in Drafts from the finder using the shared queue', async () => {
  await act(async () => field().click());
  await act(async () => button('Drafts worklist').click());
  const store = useWorkQueues.getState();
  expect(store.queues[store.active!]!.source).toBe('drafts');
  expect(store.queues[store.active!]!.items.map((item) => item.hash)).toEqual([12]);
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
  await act(async () => field().click());
  for (let attempt = 0; attempt < 6; attempt++) {
    await act(async () => button('Drafts worklist').click());
  }
  expect(usePreviewReviewStore.getState().prompt).toBe(11);
  expect(JSON.stringify(useWorkQueues.getState())).toBe(before);
  expect(sessionStorage.getItem('clarity-work-through:v1')).toBe(session);
  expect(field().getAttribute('aria-expanded')).toBe('true');
});

it('keeps the multi-selection when cancelling a target, and freezes it while choosing', async () => {
  await act(async () => field().click());
  await press(' ', true);
  await press('ArrowDown');
  await press(' ', true);
  await press('Enter', true);
  await press(' ', true);
  await act(async () => button('Cancel').click());
  expect(button('Add 2 to worklist')).toBeDefined();
  expect(host.querySelectorAll('button[aria-checked="true"]')).toHaveLength(2);
  expect(useSavedWorklists.getState().lists).toEqual([]);
});
