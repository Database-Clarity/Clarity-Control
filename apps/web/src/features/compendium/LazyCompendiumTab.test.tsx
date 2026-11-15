// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LazyCompendiumTab } from './LazyCompendiumTab';

it('loads on first mount and retries a failed chunk without losing the surrounding page', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi
    .fn<NonNullable<Parameters<typeof LazyCompendiumTab>[0]['load']>>()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ default: () => <h1>Compendium</h1> });
  try {
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <>
          <nav>Workspace</nav>
          <LazyCompendiumTab load={load} />
        </>,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load the Compendium tab",
    );
    expect(host.querySelector('nav')?.textContent).toBe('Workspace');
    await act(async () => host.querySelector('button')!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('h1')?.textContent).toBe('Compendium');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    error.mockRestore();
  }
});

it('renders an already loaded page in its first commit, with no loading fallback', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const load = vi.fn(async () => ({ default: () => <h1>Compendium</h1> }));
  try {
    await act(async () => root.render(<LazyCompendiumTab key="first" load={load} />));
    expect(host.querySelector('h1')).not.toBeNull();
    act(() => root.render(<LazyCompendiumTab key="second" load={load} />));
    // Synchronously after the reopen's commit: content, never the skeleton status.
    expect(host.querySelector('h1')?.textContent).toBe('Compendium');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
