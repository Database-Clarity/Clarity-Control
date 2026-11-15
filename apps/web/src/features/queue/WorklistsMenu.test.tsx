// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorklistsManager } from './WorklistsMenu';
import { useSavedWorklists } from './worklists';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import type { User } from '../../services/api';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
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
    dirty: [],
    removed: {},
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
