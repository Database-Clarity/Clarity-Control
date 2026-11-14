// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import { getInactiveMoves, putInactiveMove } from '../../services/inactiveMoves';
import { InactiveMoveControl } from './InactiveMoveControl';
import { Popover } from '../../ui/Popover';

vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test' }));
vi.mock('../../services/inactiveMoves', () => ({
  getInactiveMoves: vi.fn(),
  putInactiveMove: vi.fn(),
}));
vi.mock('../../ui/interaction', () => ({ useWorkspaceShortcutOwner: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
const saved = vi.fn();
const moved = { 42: { by: 1, at: '2026-11-14T00:00:00Z' } };
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
const render = (hash = 42) =>
  act(async () =>
    root.render(<InactiveMoveControl hash={hash} name="Test perk" onSaved={saved} />),
  );
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
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, token: 'token' });
  vi.mocked(getInactiveMoves).mockResolvedValue({ moves: {}, revision: null });
  vi.mocked(putInactiveMove).mockResolvedValue({ moves: moved, revision: 'a'.repeat(40) });
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
async function type(value: string) {
  await act(async () => {
    const input = document.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([1, 2, 3])('hides the inactive action for required global %s', async (hash) => {
  await render(hash);
  expect(host.textContent).toBe('');
  expect(getInactiveMoves).not.toHaveBeenCalled();
});

it('hides the action and reads nothing for non-maintainers', async () => {
  useAuthStore.setState({ user: { id: 2, login: 'bob', role: 'editor' } });
  await render();
  expect(host.textContent).toBe('');
  expect(getInactiveMoves).not.toHaveBeenCalled();
});

it('requires an explicit identity even for an item with an empty manifest name', async () => {
  await act(async () => root.render(<InactiveMoveControl hash={42} name=" " onSaved={saved} />));
  await click('Move to Inactive');
  expect(button('Stop exporting').disabled).toBe(true);
  await type('Tooltip 42');
  expect(button('Stop exporting').disabled).toBe(false);
});

it('requires exact typing, safely focuses Cancel, and ignores autopilot activation', async () => {
  await render();
  await click('Move to Inactive');
  expect(document.activeElement).toBe(button('Cancel'));
  expect(button('Stop exporting').disabled).toBe(true);
  await click('Stop exporting');
  expect(putInactiveMove).not.toHaveBeenCalled();
  await type('Test');
  expect(button('Stop exporting').disabled).toBe(true);
  await type('Test perk');
  expect(button('Stop exporting').disabled).toBe(false);
  for (const key of ['Enter', ' ']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    expect(button('Stop exporting').dispatchEvent(event)).toBe(false);
  }
  expect(putInactiveMove).not.toHaveBeenCalled();
  await act(async () => {
    button('Stop exporting').click();
    button('Stop exporting').click();
  });
  expect(putInactiveMove).toHaveBeenCalledExactlyOnceWith(42, true, null);
  expect(saved).toHaveBeenCalledWith(moved);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

it('keeps a containing tools menu mounted when the pointer confirms its nested move', async () => {
  await act(async () =>
    root.render(
      <Popover label="Tools" trigger="Tools" contain>
        <InactiveMoveControl hash={42} name="Test perk" onSaved={saved} />
      </Popover>,
    ),
  );
  await click('Tools');
  await click('Move to Inactive');
  await type('Test perk');
  await act(async () => {
    button('Stop exporting').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(2);
  await click('Stop exporting');
  expect(putInactiveMove).toHaveBeenCalledExactlyOnceWith(42, true, null);
  expect(saved).toHaveBeenCalledWith(moved);
});

it.each(['Escape', 'Back', 'Cancel'])(
  'cancels with %s, and resets confirmation on reopen',
  async (action) => {
    await render();
    await click('Move to Inactive');
    await type('Test perk');
    await act(async () => {
      if (action === 'Back') window.dispatchEvent(new PopStateEvent('popstate'));
      else if (action === 'Cancel') button('Cancel').click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(putInactiveMove).not.toHaveBeenCalled();
    await click('Move to Inactive');
    expect(document.querySelector('input')!.value).toBe('');
    expect(button('Stop exporting').disabled).toBe(true);
  },
);

it('reads the fresh move state and uses the loaded revision for move-out', async () => {
  vi.mocked(getInactiveMoves).mockResolvedValue({ moves: moved, revision: 'b'.repeat(40) });
  await render();
  await click('Move to Inactive');
  await type('Test perk');
  await click('Resume exporting');
  expect(putInactiveMove).toHaveBeenCalledWith(42, false, 'b'.repeat(40));
});

it('closes on role switch and item change, and makes conflicts require a fresh confirmation', async () => {
  await render();
  await click('Move to Inactive');
  await type('Test perk');
  vi.mocked(putInactiveMove).mockRejectedValueOnce(new Error('Inactive moves changed; reload'));
  await click('Stop exporting');
  expect(document.querySelector('[role=alert]')!.textContent).toContain('reload');
  expect(button('Stop exporting').disabled).toBe(true);
  await render(99);
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await click('Move to Inactive');
  await act(async () => {
    useAuthStore.setState({ user: null });
  });
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(host.textContent).toBe('');
});
