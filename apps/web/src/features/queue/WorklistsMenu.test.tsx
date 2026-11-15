// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoveFromWorklist, WorklistPicker, WorklistsManager } from './WorklistsMenu';
import { useSavedWorklists } from './worklists';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { resetWorkQueues, useWorkQueues } from './store';
import { startQueue } from './start';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import type { User } from '../../services/api';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: api }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  api.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  useAuthStore.setState({ user: { id: 1, role: 'editor', login: 'one' } as User });
  useSavedWorklists.setState({
    scope: '1',
    lists: [],
    pending: false,
    base: [],
    ops: [],
    loaded: [],
    index: {},
    notice: '',
  });
  useDataStore.setState({ data: null });
  setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [] }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <WorklistsManager />
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
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((button) => button.textContent === text)!;
function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function submit() {
  act(() =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
it('creates inline, renames through Enter submission, cancels deletion, and confirms deletion', () => {
  act(() => button('New worklist…').click());
  type('New worklist name', 'Weekend');
  submit();
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Weekend');
  act(() => button('Rename').click());
  type('Rename worklist', 'Renamed');
  submit();
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Renamed');
  act(() => button('Delete…').click());
  act(() => button('Cancel').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(1);
  act(() => button('Delete…').click());
  act(() => button('Delete').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(0);
});
it('cancels a new name and exposes empty-list opening as disabled', () => {
  act(() => button('New worklist…').click());
  type('New worklist name', 'Discarded');
  act(() => button('Cancel').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(0);
  act(() => useSavedWorklists.getState().add(null, 'Empty', []));
  expect(button('Open').disabled).toBe(true);
});

it('does not add entries when the picker is cancelled during a lazy list read', async () => {
  const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
  act(() =>
    useSavedWorklists.setState({
      base: [{ id, name: 'Existing', items: [] }],
      lists: [{ id, name: 'Existing', items: [] }],
      loaded: [],
      index: { [id]: { id, name: 'Existing', count: 1, updatedAt: 1, revision: 'a'.repeat(32) } },
    }),
  );
  let resolve!: (response: Response) => void;
  api.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const close = vi.fn();
  await act(async () =>
    root.render(<WorklistPicker items={[{ hash: 2, name: 'New entry' }]} close={close} />),
  );
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Existing'))!
      .click(),
  );
  await act(async () => root.render(null));
  await act(async () =>
    resolve(
      Response.json({ worklist: { id, name: 'Existing', hashes: [1] }, revision: 'a'.repeat(32) }),
    ),
  );
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([1]);
  expect(useSavedWorklists.getState().ops).toEqual([]);
  expect(close).not.toHaveBeenCalled();
});

it('removes an unavailable entry after an index-only cache refresh without dropping other entries', async () => {
  const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
  act(() =>
    useSavedWorklists.setState({
      base: [{ id, name: 'Existing', items: [] }],
      lists: [{ id, name: 'Existing', items: [] }],
      loaded: [],
      index: { [id]: { id, name: 'Existing', count: 2, updatedAt: 1, revision: 'a'.repeat(32) } },
    }),
  );
  api.mockResolvedValueOnce(
    Response.json({ worklist: { id, name: 'Existing', hashes: [1, 2] }, revision: 'a'.repeat(32) }),
  );
  await act(async () => root.render(<RemoveFromWorklist id={id} hash={1} />));
  await act(async () => button('Remove').click());
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([2]);
  expect(useSavedWorklists.getState().ops.map((op) => op.id)).toEqual([id]);
});

it.each(['custom', 'drafts'])(
  'keeps the active queue unchanged when preview review refuses %s opening',
  async (source) => {
    const data: EditorData = {
      items: Object.fromEntries(
        [1, 2].map((hash) => [
          hash,
          { hash, name: `Entry ${hash}`, icon: '', categoryId: 'perks', inGameDescription: '' },
        ]),
      ),
      aliases: {},
      categories: [],
      bundle: {
        tooltips: {},
        sourceCommit: 'fixture',
        generatedAt: '',
        permissions: { users: {} },
        pushed: {},
      },
    };
    const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
    act(() => {
      useDataStore.setState({ data });
      useSavedWorklists.setState({
        base: [{ id, name: 'Other list', items: [{ hash: 2, name: 'Two' }] }],
        lists: [{ id, name: 'Other list', items: [{ hash: 2, name: 'Two' }] }],
        loaded: [id],
      });
    });
    setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [2] }));
    const first = { key: '1', hash: 1, name: 'One' };
    startQueue({
      source: 'custom',
      scope: 'shown',
      items: [first],
      first,
      origin: { path: '/', restore: {} },
    });
    const before = JSON.stringify(useWorkQueues.getState());
    const session = sessionStorage.getItem('clarity-work-through:v1');
    const close = vi.fn();
    await act(async () =>
      root.render(
        <MemoryRouter key="guarded" initialEntries={['/t/1']}>
          <WorklistsManager close={close} />
        </MemoryRouter>,
      ),
    );
    usePreviewReviewStore.setState({
      host: { show: vi.fn() },
      entries: { 1: { canonical: 1, dirty: 2, reviewed: 1 } },
      prompt: null,
    });
    for (let attempt = 0; attempt < 6; attempt++) {
      await act(async () => button(source === 'custom' ? 'Open' : 'Drafts1').click());
    }
    expect(usePreviewReviewStore.getState().prompt).toBe(1);
    expect(JSON.stringify(useWorkQueues.getState())).toBe(before);
    expect(sessionStorage.getItem('clarity-work-through:v1')).toBe(session);
    expect(close).not.toHaveBeenCalled();
  },
);
