// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LazyMatchReviewPage } from './LazyMatchReviewPage';
import { loadedReviewPage, rememberReviewPage } from './reviewPageComponent';

it('renders prefetched code without a loading fallback and preserves the mounted page state', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous = loadedReviewPage();
  const host = document.createElement('div');
  const root = createRoot(host);
  function Prefetched() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Review {count}</button>;
  }
  try {
    rememberReviewPage(Prefetched);
    act(() => root.render(<LazyMatchReviewPage />));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toBe('Review 0');
    act(() => host.querySelector('button')!.click());
    rememberReviewPage(() => <p>Another code generation</p>);
    act(() => root.render(<LazyMatchReviewPage />));
    expect(host.textContent).toBe('Review 1');
  } finally {
    act(() => root.unmount());
    rememberReviewPage(previous);
  }
});

it('loads on first mount and retries a failed chunk without losing the surrounding page', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi
    .fn<NonNullable<Parameters<typeof LazyMatchReviewPage>[0]['load']>>()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ default: () => <h1>Review matches</h1> });
  try {
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <>
          <nav>Workspace</nav>
          <LazyMatchReviewPage load={load} />
        </>,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load Compendium review",
    );
    expect(host.querySelector('nav')?.textContent).toBe('Workspace');
    await act(async () => host.querySelector('button')!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('h1')?.textContent).toBe('Review matches');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    error.mockRestore();
  }
});
