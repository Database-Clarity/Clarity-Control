// @vitest-environment jsdom
// The account sheet loads on first use: a failed load must be retryable, and a dismissal while it
// is still loading must win over the late load (code review F1, F2).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let gate: () => Promise<void>;

let root: Root;
let host: HTMLElement;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = () => host.querySelector<HTMLButtonElement>('[data-identity-button]')!;
const dialog = () => host.querySelector('[role="dialog"]');

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', '');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
});

async function mount() {
  // Registered per test: each one controls when (and whether) the sheet's code arrives.
  vi.doMock('./ReportIdentitySheet', async () => {
    await gate();
    return {
      default: ({ open }: { open: boolean }) =>
        open ? <div role="dialog" aria-label="Account" /> : null,
    };
  });
  const { ReportIdentityMenu } = await import('./ReportIdentityMenu');
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ReportIdentityMenu />
      </MemoryRouter>,
    ),
  );
}

it('shows a failed load on the button and opens the sheet on the next press', async () => {
  let fail = true;
  gate = () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve());
  await mount();
  await act(async () => button().click());
  await flush();
  expect(dialog()).toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  expect(button().dataset.tone).toBe('error');
  expect(button().textContent).toBe('Menu unavailable');
  fail = false;
  await act(async () => button().click());
  await flush();
  expect(dialog()).not.toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('true');
  expect(button().dataset.tone).not.toBe('error');
});

it('keeps the sheet closed when Escape dismissed it before its code arrived', async () => {
  let release!: () => void;
  gate = () => new Promise<void>((resolve) => (release = resolve));
  await mount();
  await act(async () => button().click());
  expect(button().getAttribute('aria-busy')).toBe('true');
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(button().getAttribute('aria-expanded')).toBe('false');
  await act(async () => release());
  await flush();
  expect(dialog()).toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  // The loaded sheet opens on the next press without another load.
  await act(async () => button().click());
  expect(dialog()).not.toBeNull();
});

it('keeps the sheet closed when a press elsewhere dismissed it while loading', async () => {
  let release!: () => void;
  gate = () => new Promise<void>((resolve) => (release = resolve));
  await mount();
  await act(async () => button().click());
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await act(async () => release());
  await flush();
  expect(dialog()).toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('false');
});
