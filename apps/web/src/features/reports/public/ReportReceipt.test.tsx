// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('receipt page', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // Node's own localStorage global shadows jsdom's and throws without a file: stub both.
    for (const name of ['localStorage', 'sessionStorage']) {
      const storage = new Map<string, string>();
      vi.stubGlobal(name, {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      });
    }
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('moves the withdraw secret from the location into the tab and sends it in the body', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/reports/r/r-abcdefgh')) return json({ status: 'open', closed_note: null });
      if (url.endsWith('/view'))
        return json({
          id: 'r-abcdefgh',
          owner_hash: 5,
          viewed_hash: 5,
          variant: 'base',
          lang: 'en',
          seen_lang: null,
          status: 'open',
          category: 'other',
          note: '',
          created_at: 1,
          updated_at: 1,
          closed_note: null,
          files_count: 0,
          notes: [
            { n: 1, category: 'other', text: 't', exact: null, start: null, end: null, whole: 1 },
          ],
          body: init?.body,
        });
      if (url.includes('report-items.json'))
        return json({ v: 1, sourceCommit: 'a'.repeat(40), items: {} });
      throw new Error(url);
    });
    vi.stubGlobal('fetch', fetch);
    const { useAuthStore } = await import('../../../stores/auth');
    useAuthStore.setState({ user: null, loading: false });
    const { ReportReceipt } = await import('./ReportReceipt');
    const router = createMemoryRouter([{ path: '/report/r/:id', element: <ReportReceipt /> }], {
      initialEntries: ['/report/r/r-abcdefgh?w=the-secret-value-0000000000000000000'],
    });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => {});
    expect(router.state.location.search).toBe('');
    expect(sessionStorage.getItem('clarity-report-secret:r-abcdefgh')).toBe(
      'the-secret-value-0000000000000000000',
    );
    const view = fetch.mock.calls.find(([url]) => String(url).endsWith('/view')) as
      [string, RequestInit] | undefined;
    expect(JSON.parse(String(view?.[1].body))).toEqual({
      secret: 'the-secret-value-0000000000000000000',
    });
    expect(host.querySelector<HTMLTextAreaElement>('#receipt-link')?.value).toContain(
      '#/report/r/r-abcdefgh?w=the-secret-value',
    );
    expect(host.textContent).toContain('Withdraw…');
    expect(host.textContent).toContain('1 note');
  });
});
