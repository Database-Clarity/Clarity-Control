// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Marks } from '@clarity/core/marks';
import { apiRequest } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { MarksControl } from './MarksControl';
import { MarkTypes } from './MarkTypes';
import { indexMarks, useMarksStore } from './store';

vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test', apiRequest: vi.fn() }));
vi.mock('../../ui/interaction', () => ({ useWorkspaceShortcutOwner: vi.fn() }));
const at = '2026-11-15T00:00:00Z';
const marks: Marks = {
  types: [{ id: 'retest', label: 'Needs retesting', colour: 'amber', by: 1, at }],
  entries: { 42: [{ type: 'retest', note: 'Arc damage', by: 2, at }] },
};
let root: Root;
let host: HTMLDivElement;
let state: Marks;
let revision: string | null;
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.getAttribute('aria-label') === text || element.textContent?.trim() === text,
  )!;
const click = (text: string) => act(async () => button(text).click());
const render = () => act(async () => root.render(<MarksControl hash={42} />));
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  state = structuredClone(marks);
  revision = 'a'.repeat(40);
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, token: 'token' });
  useMarksStore.getState().accept(state);
  vi.mocked(apiRequest).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      const value = JSON.parse(init.body as string);
      if (value.revision !== revision)
        return Response.json({ error: 'Marks changed; reload and retry' }, { status: 409 });
      const change = value.change;
      if (change.action === 'mark')
        state.entries[42] = [{ type: change.type, note: change.note, by: 1, at }];
      if (change.action === 'unmark') state.entries = {};
      if (change.action === 'remove-type') {
        state.types = [];
        state.entries = {};
      }
      if (change.action === 'edit-type')
        state.types[0] = { ...state.types[0], label: change.label, colour: change.colour };
      if (change.action === 'create-type')
        state.types.push({ id: change.id, label: change.label, colour: change.colour, by: 1, at });
      revision = 'b'.repeat(40);
    }
    return Response.json({ marks: state, revision });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('precomputes labels and notes once per document for hash lookups', () => {
  expect(indexMarks(marks).get(42)).toEqual([
    { ...marks.entries[42][0], label: 'Needs retesting', colour: 'amber' },
  ]);
  expect(indexMarks(marks).get(99)).toBeUndefined();
});
it.each(['translator', 'trial', null] as const)(
  'shows attribution and notes, read-only for %s',
  async (role) => {
    useAuthStore.setState({ user: role ? { id: 4, login: 'dan', role } : null, token: null });
    await render();
    await click('Needs retesting');
    expect(document.body.textContent).toContain('Arc damage');
    expect(document.body.textContent).toContain('GitHub user 2');
    expect(document.body.textContent).toContain('Marks are read-only');
    expect(document.querySelector('textarea')).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  },
);
it('edits notes, removes a mark, and marks an empty entry', async () => {
  await render();
  await click('Needs retesting');
  await click('Edit mark');
  await act(async () => input(document.querySelector('textarea')!, 'Test again'));
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(useMarksStore.getState().index.get(42)![0].note).toBe('Test again');
  await click('Edit mark');
  await click('Remove mark');
  expect(useMarksStore.getState().index.get(42)).toBeUndefined();
  await act(async () => {
    const select = document.querySelector('select')!;
    select.value = 'retest';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(useMarksStore.getState().index.get(42)).toHaveLength(1);
});
it('preserves a conflicting note, disables writes, and requires an explicit reload', async () => {
  await render();
  await click('Needs retesting');
  await click('Edit mark');
  revision = 'c'.repeat(40);
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(document.querySelector('[role=alert]')!.textContent).toContain('Marks changed');
  expect(document.querySelector('textarea')!.value).toBe('Arc damage');
  expect(document.querySelector('fieldset')!.disabled).toBe(true);
  await click('Reload marks');
  expect(document.querySelector('fieldset')!.disabled).toBe(false);
});
it('clears selection when a mark type disappears on reload, and closes on sign-out', async () => {
  await render();
  await click('Needs retesting');
  await click('Edit mark');
  state = { types: [], entries: {} };
  await click('Reload marks');
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.body.textContent).toContain('No marks on this entry');
  await act(async () => useAuthStore.setState({ user: null, token: null }));
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('fails closed on malformed reloads while retaining read-only display', async () => {
  vi.mocked(apiRequest).mockResolvedValue(Response.json({ marks: {}, revision: null }));
  await render();
  await click('Needs retesting');
  expect(document.querySelector('[role=alert]')!.textContent).toContain('read-only');
  expect(document.querySelector('fieldset')!.disabled).toBe(true);
  expect(document.body.textContent).toContain('Arc damage');
});
it('requires an in-page confirmation before removing a type and all its marks', async () => {
  await act(async () => root.render(<MarkTypes />));
  await click('Remove Needs retesting');
  expect(apiRequest).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('1 entries');
  await click('Cancel removal');
  expect(document.querySelector('[aria-label="Confirm mark type removal"]')).toBeNull();
  await click('Remove Needs retesting');
  await click('Remove type and marks');
  expect(useMarksStore.getState().marks).toEqual({ types: [], entries: {} });
  expect(JSON.parse(vi.mocked(apiRequest).mock.calls[1][1]!.body as string).change).toEqual({
    action: 'remove-type',
    id: 'retest',
    force: true,
  });
});
it('renames and recolours a type, and supports canceling an edit', async () => {
  await act(async () => root.render(<MarkTypes />));
  await click('Edit Needs retesting');
  await click('Cancel edit');
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
  await click('Edit Needs retesting');
  await act(async () => input(document.querySelector('input')!, 'Retest'));
  await act(async () => {
    const select = document.querySelector('select')!;
    select.value = 'red';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(useMarksStore.getState().marks.types[0]).toMatchObject({
    label: 'Retest',
    colour: 'red',
    by: 1,
    at,
  });
});
it('creates a new mark type with an optional colour', async () => {
  await act(async () => root.render(<MarkTypes />));
  await act(async () => input(document.querySelector('input')!, 'Needs testing'));
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(useMarksStore.getState().marks.types).toHaveLength(2);
  expect(useMarksStore.getState().marks.types[1]).toMatchObject({
    label: 'Needs testing',
    colour: 'neutral',
    by: 1,
  });
});
it('closes the mark editor when navigation changes the current entry', async () => {
  await render();
  await click('Needs retesting');
  await act(async () => root.render(<MarksControl hash={43} />));
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
