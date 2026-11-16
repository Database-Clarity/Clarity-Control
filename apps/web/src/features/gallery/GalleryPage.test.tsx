// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';

vi.mock('../../stores/auth', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ user: { role: 'maintainer' }, loading: false }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter>
        <GalleryPage />
      </MemoryRouter>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function ready(source: Window | null, origin = window.location.origin) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'gallery-ready',
        source,
        origin,
      }),
    ),
  );
}

it('shows a useful fallback when load fires but the app never mounts', () => {
  const frame = host.querySelector('iframe')!;
  act(() => frame.dispatchEvent(new Event('load')));
  act(() => vi.advanceTimersByTime(15_000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Preview could not load');
  expect(frame.hidden).toBe(true);
  ready(frame.contentWindow);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(frame.hidden).toBe(false);
});

it('accepts readiness only from the same-origin preview and cancels the timeout', () => {
  const frame = host.querySelector('iframe')!;
  ready(window);
  ready(frame.contentWindow, 'https://other.test');
  act(() => vi.advanceTimersByTime(15_000));
  expect(frame.hidden).toBe(true);
  ready(frame.contentWindow);
  act(() => vi.advanceTimersByTime(30_000));
  expect(frame.hidden).toBe(false);
});
