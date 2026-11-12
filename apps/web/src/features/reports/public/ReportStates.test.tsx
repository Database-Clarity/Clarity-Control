// @vitest-environment jsdom
// State transitions from the code review: locale changes by URL, human-check retry, the frozen
// form while sending, and receipt / My reports state scoped to one report and one account.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const commit = 'a'.repeat(40);
const catalog = {
  v: 1,
  sourceCommit: commit,
  items: {
    '100': {
      owner: 100,
      langs: ['en', 'de'],
      variant: 'base',
      name: 'Base Perk',
      icon: '',
      category: 'weapon-trait',
      type: 'Weapon Trait',
    },
  },
};
const tooltip = {
  text: { en: { text: 'English line one\nEnglish line two' }, de: { text: 'Deutsche Zeile' } },
};
const globalsFile = { text: { en: { text: '' } } };

const mount = vi.fn();
vi.mock('./turnstile', () => ({ mountHumanCheck: (...args: unknown[]) => mount(...args) }));

let root: Root;
let host: HTMLElement;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
/**
 * Waits until the form shows what the next step needs. Loading the tooltip ends with a SHA-256
 * digest (`displayRevision`) that Node runs on its thread pool, so it is not done after any fixed
 * number of timer turns: under load it can land after them. Wait for the DOM instead.
 */
async function until(ready: () => boolean, what: string) {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`The form never showed ${what}`);
    await flush();
  }
}
const tooltipShown = () => host.querySelector('[data-line]') !== null;

beforeEach(() => {
  vi.resetModules();
  mount.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
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

/** Serves the catalog, tooltip files, and public anchors; `api` answers Worker calls. */
function stubFetch(api: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('report-items.json')) return json(catalog);
    const file = /\/tooltips\/(\d+)\.json$/.exec(url);
    if (file) return json(file[1] === '100' ? tooltip : globalsFile);
    if (url.includes('/reports/public')) return json([]);
    return api(url, init);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function renderForm(entry: string) {
  const { useAuthStore } = await import('../../../stores/auth');
  useAuthStore.setState({ user: null, loading: false });
  const { ReportForm } = await import('./ReportForm');
  const router = createMemoryRouter(
    [
      { path: '/report/:hash', element: <ReportForm /> },
      { path: '/report', element: <p>Picker</p> },
      { path: '/report/r/:id', element: <p>Receipt</p> },
    ],
    { initialEntries: [entry] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await until(tooltipShown, 'the tooltip');
  return router;
}

const draftOf = () => JSON.parse(sessionStorage.getItem('clarity-report-draft:100') ?? 'null');

async function typeInto(field: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function markFirstLine() {
  const line = host.querySelector<HTMLElement>('[data-line]')!;
  await act(async () => {
    line.focus();
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function writeWholeNote(text: string) {
  const whole = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Whole tooltip'),
  )!;
  await act(async () => whole.click());
  const field = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('report form states', () => {
  it('turns marks into Re-mark notes when the locale changes through the URL', async () => {
    stubFetch(() => json({}, 404));
    const router = await renderForm('/report/100?lang=en');
    const line = host.querySelector<HTMLElement>('[data-line]')!;
    await act(async () => {
      line.focus();
      line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(draftOf().notes[0].mark).toEqual({ start: 0, end: 16 });
    await act(async () => router.navigate('/report/100?lang=de'));
    await until(() => host.textContent!.includes('Deutsche Zeile'), 'the German tooltip');
    expect(draftOf()).toMatchObject({ lang: 'de' });
    expect(draftOf().notes[0]).toMatchObject({ mark: null, remark: 'English line one' });
  });

  it('reconnects a Re-mark note to the next mark, keeping its text', async () => {
    stubFetch(() => json({}, 404));
    const router = await renderForm('/report/100?lang=en');
    await markFirstLine();
    await typeInto(host.querySelector('textarea')!, 'Wrong number.');
    await act(async () => router.navigate('/report/100?lang=de'));
    await until(() => host.textContent!.includes('Deutsche Zeile'), 'the German tooltip');
    await markFirstLine();
    expect(draftOf().notes).toHaveLength(1);
    expect(draftOf().notes[0]).toMatchObject({
      text: 'Wrong number.',
      mark: { start: 0, end: 14 },
    });
    expect(draftOf().notes[0].remark).toBeUndefined();
  });

  it('lets a late send result neither clear newer text nor move the page', async () => {
    vi.stubEnv('VITE_API_URL', 'https://worker.example');
    let answer: (response: Response) => void = () => undefined;
    stubFetch(
      (url) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith('/reports')) answer = resolve;
        }),
    );
    mount.mockResolvedValue({
      token: async () => 'XXXX.DUMMY.TOKEN.XXXX',
      reset: () => undefined,
      remove: () => undefined,
    });
    const router = await renderForm('/report/100?lang=en');
    await writeWholeNote('First version of the note.');
    await act(async () => host.querySelector('form')!.requestSubmit());
    await flush();
    await act(async () => router.navigate('/report'));
    await act(async () => router.navigate('/report/100?lang=en'));
    await until(() => tooltipShown() && host.querySelector('textarea') !== null, 'the kept note');
    await typeInto(host.querySelector('textarea')!, 'A newer, unsent version.');
    await act(async () => answer(json({ id: 'r-abcdefgh', status: 'open' })));
    await flush();
    expect(router.state.location.pathname).toBe('/report/100');
    expect(draftOf().notes[0].text).toBe('A newer, unsent version.');
    expect(draftOf().pending).toBeUndefined();
    expect(sessionStorage.getItem('clarity-report-secret:r-abcdefgh')).toBeTruthy();
  });

  it('mounts the human check again on Send after a failed mount, and freezes the form while sending', async () => {
    vi.stubEnv('VITE_API_URL', 'https://worker.example');
    let answer: (response: Response) => void = () => undefined;
    stubFetch(
      (url) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith('/reports')) answer = resolve;
        }),
    );
    mount.mockRejectedValueOnce(new Error('blocked')).mockResolvedValue({
      token: async () => 'XXXX.DUMMY.TOKEN.XXXX',
      reset: () => undefined,
      remove: () => undefined,
    });
    await renderForm('/report/100?lang=en');
    expect(mount).toHaveBeenCalledTimes(1);
    await writeWholeNote('The value is wrong in the current patch.');
    const form = host.querySelector('form')!;
    await act(async () => form.requestSubmit());
    await flush();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => answer(json({ id: 'r-abcdefgh', status: 'open' })));
    await flush();
    expect(draftOf()).toBeNull();
  });
});

describe('receipt and My reports scope', () => {
  it('never sends one report’s secret for another, and drops one account’s rows for the next', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/reports/r/r-aaaaaaaa') || url.endsWith('/reports/r/r-bbbbbbbb'))
        return json({ status: 'open', closed_note: null });
      if (url.endsWith('/view')) return json({}, 404);
      if (url.includes('report-items.json')) return json(catalog);
      if (url.endsWith('/reports/mine'))
        return json([
          {
            id: 'r-aaaaaaaa',
            owner_hash: 100,
            viewed_hash: 100,
            lang: 'en',
            status: 'open',
            created_at: 1,
            updated_at: 1,
            closed_note: 'A only',
          },
        ]);
      throw new Error(url);
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('VITE_API_URL', 'https://worker.example');
    const { useAuthStore } = await import('../../../stores/auth');
    useAuthStore.setState({ user: null, loading: false });
    const { ReceiptForReport, MyReportsForAccount } = await import('./ReportPublicPage');
    const router = createMemoryRouter(
      [
        { path: '/report/r/:id', element: <ReceiptForReport /> },
        { path: '/report/mine', element: <MyReportsForAccount /> },
      ],
      { initialEntries: ['/report/r/r-aaaaaaaa?w=secret-a-000000000000000000000000000000'] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    await flush();
    await act(async () => router.navigate('/report/r/r-bbbbbbbb'));
    await flush();
    const views = fetch.mock.calls.filter(([url]) => String(url).endsWith('/view'));
    expect(views.map(([url]) => String(url))).toEqual([
      'https://worker.example/reports/r/r-aaaaaaaa/view',
    ]);
    expect(host.querySelector('#receipt-link')).toBeNull();

    await act(async () =>
      useAuthStore.setState({ user: { login: 'alice' } as never, loading: false }),
    );
    await act(async () => router.navigate('/report/mine'));
    await flush();
    expect(host.textContent).toContain('A only');
    fetch.mockImplementation(async (url: string) =>
      url.endsWith('/reports/mine') ? json({ error: 'Down' }, 503) : json(catalog),
    );
    await act(async () =>
      useAuthStore.setState({ user: { login: 'bob' } as never, loading: false }),
    );
    await flush();
    expect(host.textContent).not.toContain('A only');
  });
});
