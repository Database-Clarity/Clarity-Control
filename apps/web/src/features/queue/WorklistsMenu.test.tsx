// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoveFromWorklist, WorklistPicker, WorklistsManager } from './WorklistsMenu';
import { syncWorklists, useSavedWorklists } from './worklists';
import { applyWorklistOperation } from '../../../../../packages/core/src/worklists';
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
let rows: Map<string, { name: string; hashes: number[] }>;
let revision: string;
const sessionToken = `${btoa(JSON.stringify({ exp: 4102444800 }))}.test`;
beforeEach(async () => {
  vi.useFakeTimers();
  api.mockReset();
  rows = new Map();
  revision = 'a'.repeat(32);
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/worklists')
      return Response.json({
        lists: [...rows].map(([id, row]) => ({
          id,
          name: row.name,
          count: row.hashes.length,
          revision,
          updatedAt: 1,
        })),
      });
    const id = path.split('/').at(-1)!;
    if (init?.method === 'PUT') {
      const { op } = JSON.parse(String(init.body));
      const next = applyWorklistOperation(rows.get(id) ?? null, op);
      if (next) rows.set(id, next);
      else rows.delete(id);
    }
    return Response.json({
      worklist: rows.has(id) ? { id, ...rows.get(id)! } : null,
      revision: rows.has(id) ? revision : null,
    });
  });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  sessionStorage.setItem('clarity-editor-session', sessionToken);
  useAuthStore.setState({
    user: { id: 1, role: 'editor', login: 'one' } as User,
    loading: false,
    token: sessionToken,
  });
  useSavedWorklists.setState({
    scope: '1',
    saving: [],
    failed: [],
    lists: [],

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
it('creates inline, renames through Enter submission, cancels deletion, and confirms deletion', async () => {
  act(() => button('New worklist…').click());
  type('New worklist name', 'Weekend');
  await act(async () => submit());
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Weekend');
  act(() => button('Rename').click());
  type('Rename worklist', 'Renamed');
  await act(async () => submit());
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Renamed');
  act(() => button('Delete…').click());
  act(() => button('Cancel').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(1);
  act(() => button('Delete…').click());
  await act(async () => button('Delete').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(0);
});
it('cancels a new name and exposes empty-list opening as disabled', async () => {
  act(() => button('New worklist…').click());
  type('New worklist name', 'Discarded');
  act(() => button('Cancel').click());
  expect(useSavedWorklists.getState().lists).toHaveLength(0);
  await act(async () => {
    await useSavedWorklists.getState().add(null, 'Empty', []);
  });
  expect(button('Open').disabled).toBe(true);
});

it('keeps a save submitted before picker cancellation, without closing the cancelled picker', async () => {
  const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
  rows.set(id, { name: 'Existing', hashes: [1] });
  act(() =>
    useSavedWorklists.setState({
      lists: [{ id, name: 'Existing', items: [] }],
      loaded: [],
      index: { [id]: { id, name: 'Existing', count: 1, updatedAt: 1, revision } },
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = api.getMockImplementation()!;
  api.mockImplementationOnce(async (path, init) => {
    const response = await server(path, init);
    await gate;
    return response;
  });
  const close = vi.fn();
  await act(async () =>
    root.render(<WorklistPicker items={[{ hash: 2, name: 'New entry' }]} close={close} />),
  );
  await act(async () => button('Existing1').click());
  expect(api.mock.calls[0]![1].method).toBe('PUT');
  await act(async () => root.render(null));
  await act(async () => release());
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([1, 2]);
  expect(close).not.toHaveBeenCalled();
});
it('removes an unavailable run entry directly after an index-only cache refresh', async () => {
  const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
  rows.set(id, { name: 'Existing', hashes: [1, 2] });
  act(() =>
    useSavedWorklists.setState({
      lists: [{ id, name: 'Existing', items: [] }],
      loaded: [],
      index: { [id]: { id, name: 'Existing', count: 2, updatedAt: 1, revision } },
    }),
  );
  await act(async () => root.render(<RemoveFromWorklist id={id} hash={1} />));
  await act(async () => button('Remove').click());
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([2]);
  expect(api.mock.calls[0]![1].method).toBe('PUT');
});
it.each(['add', 'remove'])(
  'offers explicit Retry when an index-only %s fails offline (F2)',
  async (op) => {
    const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
    rows.set(id, { name: 'Existing', hashes: [1, 2] });
    act(() =>
      useSavedWorklists.setState({
        lists: [{ id, name: 'Existing', items: [] }],
        loaded: [],
        index: { [id]: { id, name: 'Existing', count: 2, updatedAt: 1, revision } },
      }),
    );
    await act(async () =>
      root.render(
        op === 'add' ? (
          <WorklistPicker items={[{ hash: 3, name: 'Three' }]} close={() => {}} />
        ) : (
          <RemoveFromWorklist id={id} hash={1} />
        ),
      ),
    );
    api.mockRejectedValueOnce(new Error('offline'));
    await act(async () => button(op === 'add' ? 'Existing2' : 'Remove').click());
    expect(useSavedWorklists.getState().failed[0]!.op.type).toBe(op);
    expect(host.textContent).toContain('Retry');
    expect(api.mock.calls[0]![1].method).toBe('PUT');
  },
);
it('queues a remove click before a later Retry add, even when the row is not loaded (F1)', async () => {
  const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
  rows.set(id, { name: 'Existing', hashes: [1, 2] });
  act(() =>
    useSavedWorklists.setState({
      lists: [{ id, name: 'Existing', items: [] }],
      loaded: [],
      index: { [id]: { id, name: 'Existing', count: 2, updatedAt: 1, revision } },
    }),
  );
  api.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await useSavedWorklists.getState().add(id, '', [{ hash: 1, name: 'One' }]);
  });
  await act(async () => root.render(<RemoveFromWorklist id={id} hash={1} />));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = api.getMockImplementation()!;
  api.mockImplementationOnce(async (path, init) => {
    const response = await server(path, init);
    await gate;
    return response;
  });
  await act(async () => button('Remove').click());
  await act(async () => button('Retry').click());
  await act(async () => release());
  expect(
    api.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .slice(-2)
      .map(([, init]) => JSON.parse(String(init.body)).op.type),
  ).toEqual(['remove', 'add']);
  expect(rows.get(id)!.hashes).toEqual([2, 1]);
});
it('reloads an expanded list after a focus/index refresh invalidates its entries (F3)', async () => {
  await act(async () => {
    await useSavedWorklists.getState().add(null, 'Visible', [{ hash: 1, name: 'One' }]);
  });
  const id = useSavedWorklists.getState().lists[0]!.id;
  const details = host.querySelector('details')!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(host.querySelectorAll('ol li')).toHaveLength(1);
  rows.set(id, { name: 'Visible', hashes: [1, 2, 3] });
  revision = 'b'.repeat(32);
  await act(async () => {
    await syncWorklists();
  });
  expect(host.querySelectorAll('ol li')).toHaveLength(3);
  expect(host.textContent).not.toContain('Loading entries…');
  expect(button('Rename').disabled).toBe(false);
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

it('shows Saving on the affected list, keeps its saved state on failure, and retries once on click', async () => {
  await act(async () => {
    await useSavedWorklists.getState().add(null, 'Weekend', []);
  });
  const id = useSavedWorklists.getState().lists[0]!.id;
  let reject!: (reason: Error) => void;
  api.mockImplementationOnce(
    () =>
      new Promise<Response>((_, fail) => {
        reject = fail;
      }),
  );
  act(() => button('Rename').click());
  type('Rename worklist', 'Changed');
  await act(async () => submit());
  expect(host.querySelector('summary')!.textContent).toContain('Saving…');
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Weekend');
  await act(async () => reject(new Error('offline')));
  expect(host.textContent).toContain("Couldn't save —");
  expect(host.querySelector('summary')!.textContent).not.toContain('Saving…');
  const writes = api.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
  await act(async () => button('Sync').click());
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(writes);
  await act(async () => button('Retry').click());
  expect(useSavedWorklists.getState().lists.find((list) => list.id === id)!.name).toBe('Changed');
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(writes + 1);
  expect(host.textContent).not.toContain("Couldn't save");
});
it('keeps a failed create retryable in the picker without adding an optimistic list', async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(<WorklistPicker items={[{ hash: 1, name: 'One' }]} close={close} />),
  );
  type('New worklist name', 'New');
  api.mockRejectedValueOnce(new Error('offline'));
  await act(async () => submit());
  expect(useSavedWorklists.getState().lists).toEqual([]);
  expect(close).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Couldn't save —");
  await act(async () => button('Retry').click());
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('New');
  expect(useSavedWorklists.getState().lists[0]!.items[0]!.hash).toBe(1);
});
