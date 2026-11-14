// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang, LangText, Tooltip } from '@clarity/core';
import {
  createBatchFixture,
  type BatchFixture,
  type FixtureRole,
} from '../../services/scheduled/fixtureWorker.testSupport';

const t0 = '2026-10-01T00:00:00.000Z';
const t1 = '2026-11-01T00:00:00.000Z';
const t2 = '2026-11-10T00:00:00.000Z';
const entry = (text: string, updatedAt: string, sourceUpdatedAt?: string): LangText => ({
  text,
  updatedAt,
  updatedBy: 'x',
  ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
});
const tooltip = (hash: number, text: Partial<Record<Lang, LangText>>): Tooltip => ({
  hash,
  associated: [],
  text,
});
const current: Record<number, Tooltip> = {
  1: tooltip(1, { en: entry('One', t0), de: entry('Eins', t0, t0) }),
  2: tooltip(2, { en: entry('Two', t0), de: entry('Zwei', t0, t0) }),
  3: tooltip(3, { en: entry('Three', t0), de: entry('Drei', t0, t0) }),
  4: tooltip(4, { en: entry('Four', t0) }),
};
const names: Record<number, [string, string]> = {
  1: ['Alpha Perk', 'perks'],
  2: ['Bravo Perk', 'perks'],
  3: ['Charlie Mod', 'mods'],
  4: ['Delta Mod', 'mods'],
};
const data = {
  categories: [
    { id: 'perks', label: 'Perks', group: 'Weapons', order: 1 },
    { id: 'mods', label: 'Mods', group: 'Armor', order: 2 },
  ],
  items: Object.fromEntries(
    Object.entries(names).map(([hash, [name, categoryId]]) => [
      hash,
      { hash: Number(hash), name, icon: '', categoryId, inGameDescription: '' },
    ]),
  ),
  aliases: {},
  bundle: {
    sourceCommit: 'abc',
    generatedAt: t0,
    tooltips: current,
    permissions: { users: {} },
    pushed: {},
  },
};

let fixture: BatchFixture;
let host: HTMLDivElement;
let root: Root;
let location: ReturnType<typeof useLocation>;
function Probe() {
  location = useLocation();
  return null;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = createBatchFixture({ current, user: { id: 1, login: 'm', role: 'maintainer' } });
  vi.stubGlobal('fetch', fixture.fetch);
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
    });
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function post(path: string, body: unknown) {
  const response = await fixture.handle(
    new Request(`https://worker.example${path}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  expect(response!.status).toBe(200);
  return (await response!.json()) as { batch: { id: string; revision: number } };
}

/**
 * "December patch": new English for 1, 2, and 3; German for 2 written against the new English
 * (Ready), and for 3 against an older batch English (Stale once the English moves again).
 */
async function seed() {
  const { batch } = await post('/batches', { name: 'December patch' });
  const saved = await post(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      {
        hash: 1,
        base: current[1],
        next: tooltip(1, { ...current[1]!.text, en: entry('One new', t1) }),
      },
      {
        hash: 2,
        base: current[2],
        next: tooltip(2, { en: entry('Two new', t1), de: entry('Zwei neu', t1, t1) }),
      },
      {
        hash: 3,
        base: current[3],
        next: tooltip(3, { en: entry('Three new', t1), de: entry('Drei neu', t1, t1) }),
      },
    ],
  });
  return saved.batch;
}

async function settle(done: () => boolean = () => true) {
  for (let i = 0; i < 400 && !done(); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function mount(
  role: FixtureRole,
  languages?: string[],
  entries: { pathname: string; search?: string; state?: unknown }[] = [
    { pathname: '/translations' },
  ],
) {
  fixture.setUser({ id: 1, login: 'm', role, languages });
  const { TranslationsPage } = await import('./TranslationsPage');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDataStore } = await import('../../stores/data');
  useDataStore.setState({ status: 'ready', data: data as never });
  useAuthStore.setState({
    user: role ? ({ id: 1, login: 'm', role, languages } as never) : null,
    loading: false,
  });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={entries}>
        <Probe />
        <Routes>
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="/t/:hash" element={<p>Editor</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await settle();
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === text);
const rows = () =>
  [...host.querySelectorAll<HTMLAnchorElement>('li[data-index] a')].map((row) =>
    [...row.querySelectorAll('span')].map((span) => span.textContent).join(' | '),
  );
const listings = () => fixture.log.filter((entry) => entry.path === '/batches').length;

describe('Translations Upcoming', () => {
  it('lists upcoming rows with their states and opens one in the batch destination', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    await mount('maintainer');
    expect(button('Current')?.getAttribute('aria-pressed')).toBe('true');
    // Current makes no batch request.
    expect(listings()).toBe(0);
    await act(async () => button('Upcoming')!.click());
    await settle(() => rows().length > 0);
    expect(button('Upcoming')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toEqual([
      'Alpha Perk | Perks | Needs translation',
      'Bravo Perk | Perks | Ready',
      'Charlie Mod | Mods | Ready',
    ]);
    expect(button('To do 1')).toBeDefined();
    expect(button('Ready 2')).toBeDefined();
    // Maintainer coverage counts the upcoming states per language.
    const german = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Upcoming coverage"] button[aria-label^="German"]',
    )!;
    expect(german.getAttribute('aria-label')).toBe(
      'German: 2 ready, 0 current changed, 0 stale, 1 need translation',
    );
    const french = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Upcoming coverage"] button[aria-label^="French"]',
    )!;
    expect(french.getAttribute('aria-label')).toBe(
      'French: 0 ready, 0 current changed, 0 stale, 3 need translation',
    );

    // Opening a row shows the read-only batch view in this tab; nothing opens the editor.
    await act(async () => host.querySelector<HTMLAnchorElement>('li[data-index] a')!.click());
    expect(location.pathname).toBe('/translations');
    expect(new URLSearchParams(location.search).get('open')).toBe(`${batch.id}:1`);
    const view = host.querySelector('[aria-label="Upcoming German translation"]')!;
    expect(view.querySelector('h1')!.textContent).toBe('Alpha Perk');
    expect(view.textContent).toContain('Needs translation');
    expect(view.textContent).toContain('December patch');
    expect(view.textContent).toContain('Read-only. Editing translations in a batch arrives');
    expect(view.textContent).toContain('The batch has no German for its English yet.');
    // The batch English with the change from current English.
    expect(view.querySelector('del')).toBeNull();
    expect(view.querySelector('ins')?.textContent).toContain('new');
    expect(view.querySelector('textarea, [contenteditable="true"], input:not([type])')).toBeNull();
    expect(view.textContent).toContain('1 of 3');
    // Next steps through the rows shown; Back returns to the list.
    await act(async () =>
      [...view.querySelectorAll('a')].find((link) => link.textContent === 'Next')!.click(),
    );
    expect(new URLSearchParams(location.search).get('open')).toBe(`${batch.id}:2`);
    expect(host.querySelector('h1')!.textContent).toBe('Bravo Perk');
    expect(host.textContent).toContain('Zwei neu');
    await act(async () => button('‹ Upcoming')!.click());
    await settle(() => rows().length > 0);
    expect(new URLSearchParams(location.search).get('open')).toBeNull();
    expect(button('Upcoming')?.getAttribute('aria-pressed')).toBe('true');
    // No write of any kind.
    expect(fixture.log.every((entry) => entry.method === 'GET')).toBe(true);
  });

  it('marks rows stale after a batch English edit and current changed after a current edit', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    await mount('maintainer');
    await act(async () => button('Upcoming')!.click());
    await settle(() => rows().length === 3);
    // The batch English of 3 changes after its German; current German of 2 is edited.
    const { batch: after } = await post(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [
        {
          hash: 3,
          base: tooltip(3, { en: entry('Three new', t1), de: entry('Drei neu', t1, t1) }),
          next: tooltip(3, { en: entry('Three newer', t2), de: entry('Drei neu', t1, t1) }),
        },
      ],
    });
    expect(after.revision).toBeGreaterThan(batch.revision);
    const { useDataStore } = await import('../../stores/data');
    useDataStore.setState({
      data: {
        ...data,
        bundle: {
          ...data.bundle,
          tooltips: {
            ...current,
            2: tooltip(2, { en: entry('Two', t0), de: entry('Zwei, korrigiert', t2, t0) }),
          },
        },
      } as never,
    });
    const { refreshBatches } = await import('../tooltip/UpcomingSwitch.load');
    await act(async () => refreshBatches());
    await settle(() => rows().some((row) => row.endsWith('Stale')));
    expect(rows()).toEqual([
      'Alpha Perk | Perks | Needs translation',
      'Charlie Mod | Mods | Stale',
      'Bravo Perk | Perks | Current changed',
    ]);
  });

  it('never says there is nothing to translate beside a member load error', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    await seed();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.includes('raw.githubusercontent.com')
        ? Promise.resolve(new Response('fail', { status: 500 }))
        : fixture.fetch(input, init),
    );
    await mount('maintainer');
    await act(async () => button('Upcoming')!.click());
    await settle(() => host.textContent!.includes('did not load'));
    expect(host.textContent).toContain('"December patch" did not load.');
    expect(host.textContent).not.toContain('No open batch changes English');
    expect(rows()).toEqual([]);
  });

  it('keeps Back to the list entry and its row after stepping', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    await mount('maintainer');
    await act(async () => button('Upcoming')!.click());
    await settle(() => rows().length === 3);
    const charlie = [...host.querySelectorAll<HTMLAnchorElement>('li[data-index] a')][2]!;
    await act(async () => charlie.click());
    expect(new URLSearchParams(location.search).get('open')).toBe(`${batch.id}:3`);
    await act(async () =>
      [...host.querySelectorAll('a')].find((link) => link.textContent === 'Previous')!.click(),
    );
    expect(new URLSearchParams(location.search).get('open')).toBe(`${batch.id}:2`);
    await act(async () => button('‹ Upcoming')!.click());
    await settle(() => rows().length === 3);
    expect(new URLSearchParams(location.search).get('open')).toBeNull();
    expect(
      host.querySelector('li[data-index] a[data-selected]')?.querySelector('span')?.textContent,
    ).toBe('Charlie Mod');
  });

  it('keeps a filter typed inside the debounce when Enter opens the first match', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    await mount('maintainer');
    await act(async () => button('Upcoming')!.click());
    await settle(() => rows().length === 3);
    const input = host.querySelector<HTMLInputElement>('input[type=search]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Charlie');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(new URLSearchParams(location.search).get('open')).toBe(`${batch.id}:3`);
    await act(async () => button('‹ Upcoming')!.click());
    await settle(() => rows().length === 1);
    expect(new URLSearchParams(location.search).get('q')).toBe('Charlie');
    expect(new URLSearchParams(location.search).get('open')).toBeNull();
  });

  it('says a linked row did not load, with Retry, when its members fail', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    let fail = true;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      fail && new Request(input, init).url.includes('raw.githubusercontent.com')
        ? Promise.resolve(new Response('fail', { status: 500 }))
        : fixture.fetch(input, init),
    );
    await mount('maintainer', undefined, [
      { pathname: '/translations', search: `?open=${batch.id}:2` },
    ]);
    await settle(() => host.textContent!.includes('did not load'));
    expect(host.textContent).toContain('"December patch" did not load.');
    expect(host.textContent).not.toContain('no longer upcoming');
    fail = false;
    await act(async () => button('Retry')!.click());
    await settle(() => host.querySelector('h1')?.textContent === 'Bravo Perk');
    expect(host.querySelector('h1')!.textContent).toBe('Bravo Perk');
  });

  it('shows a translator only assigned languages and no coverage', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    await seed();
    await mount('translator', ['fr']);
    await act(async () => button('Upcoming')!.click());
    await settle(() => rows().length > 0);
    expect(rows().every((row) => row.endsWith('Needs translation'))).toBe(true);
    expect(host.textContent).toContain('French');
    expect(host.querySelector('select option[value="de"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Upcoming coverage"]')).toBeNull();
  });

  it('gives trials and switch-OFF builds no switch and no batch request', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    await seed();
    await mount('trial');
    expect(button('Upcoming')).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    vi.resetModules();
    await mount('maintainer');
    expect(button('Upcoming')).toBeUndefined();
    expect(host.textContent).toContain('to translate');
    expect(listings()).toBe(0);
  });

  it('opens a linked row in the Upcoming view and flags current changed', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seed();
    const { useDataStore } = await import('../../stores/data');
    await mount('maintainer', undefined, [
      { pathname: '/translations', search: `?open=${batch.id}:2` },
    ]);
    useDataStore.setState({
      data: {
        ...data,
        bundle: {
          ...data.bundle,
          tooltips: {
            ...current,
            2: tooltip(2, { en: entry('Two', t0), de: entry('Zwei, korrigiert', t2, t0) }),
          },
        },
      } as never,
    });
    await settle(() => host.querySelector('h1')?.textContent === 'Bravo Perk');
    const view = host.querySelector('[aria-label="Upcoming German translation"]')!;
    expect(view.textContent).toContain('Current changed');
    expect(view.textContent).toContain('Current German was edited after this rework');
    expect(view.textContent).toContain('Zwei, korrigiert');
    expect(view.textContent).toContain('Zwei neu');
  });
});
