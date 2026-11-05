// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppLazyPage } from './AppLazyPage';
import { renderToStaticMarkup } from 'react-dom/server';
import { workspacePage } from './workspacePreload';

it('renders code resolved by idle preload without mounting a Suspense loading stage', async () => {
  const fetchModule = vi.fn(async () => ({ default: () => <h1>Review changes</h1> }));
  const load = workspacePage(fetchModule);
  await load();
  const html = renderToStaticMarkup(<AppLazyPage load={load} />);
  expect(html).toContain('Review changes');
  expect(html).not.toContain('Loading page');
  expect(fetchModule).toHaveBeenCalledOnce();
});

it('keeps the retry boundary around a synchronously available page', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let fail = true;
  const load = workspacePage(async () => ({
    default: () => {
      if (fail) throw new Error('Temporary page error');
      return <h1>Recovered page</h1>;
    },
  }));
  await load();
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const expectedError = (event: ErrorEvent) => {
    if (event.error instanceof Error && event.error.message === 'Temporary page error')
      event.preventDefault();
  };
  window.addEventListener('error', expectedError);
  try {
    await act(async () => root.render(<AppLazyPage load={load} />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('h1')?.textContent).toBe('Recovered page');
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener('error', expectedError);
    error.mockRestore();
  }
});

it('loads on first mount and retries a failed chunk without losing the surrounding page', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi
    .fn<NonNullable<Parameters<typeof AppLazyPage>[0]['load']>>()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ default: () => <h1>Review matches</h1> });
  try {
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <>
          <nav>Workspace</nav>
          <AppLazyPage load={load} />
        </>,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load page");
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
