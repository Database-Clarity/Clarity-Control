// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { PreviewColumnProps } from '../preview';
import {
  createBatchFixture,
  type BatchFixture,
} from '../../services/scheduled/fixtureWorker.testSupport';

vi.mock('../editor', () => ({
  ClarityEditor: ({ tooltipHash }: { tooltipHash: number }) => <div data-editor={tooltipHash} />,
}));
// The preview column is drawn by its own tests; here it reports what the page asked it to render.
vi.mock('../preview', () => ({
  PreviewColumn: (props: PreviewColumnProps) => (
    <div
      data-preview=""
      data-text={props.baseText}
      data-enhanced={props.enhanced.map((view) => view.text).join('|')}
      data-import={props.baseGlobals.imports?.['13'] ?? ''}
      data-loading={String(Boolean(props.loadingContent))}
    >
      {props.source}
    </div>
  ),
}));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));

const stamp = { updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' };
const tooltip = (hash: number, en: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, ...stamp } },
});
const current = {
  10: tooltip(10, 'English 10 import 13 from tooltip'),
  // Derived: the enhanced version holds the base text, so it renders the base through its type.
  11: tooltip(11, 'English 10 import 13 from tooltip'),
  12: tooltip(12, 'English 12'),
  13: tooltip(13, 'English 13'),
};
const data = {
  aliases: {},
  categories: [
    { id: 'perks', label: 'Perks', group: 'Weapons', order: 1, legacyType: 'Weapon Perk' },
    {
      id: 'perks-enhanced',
      label: 'Perks Enhanced',
      group: 'Weapons',
      order: 2,
      legacyType: 'Weapon Perk Enhanced',
    },
  ],
  items: {
    10: { hash: 10, name: 'A base', icon: '', categoryId: 'perks', enhancedHashes: [11] },
    11: { hash: 11, name: 'A enhanced', icon: '', categoryId: 'perks-enhanced', baseHash: 10 },
    12: { hash: 12, name: 'Other', icon: '', categoryId: 'perks' },
    13: { hash: 13, name: 'Imported', icon: '', categoryId: 'perks' },
  },
  bundle: {
    sourceCommit: 'test',
    generatedAt: '2026-02-01T00:00:00Z',
    tooltips: current,
    permissions: { users: {} },
    pushed: {},
  },
};

let fixture: BatchFixture;
let requests: string[];
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  for (const name of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  fixture = createBatchFixture({
    current,
    user: { id: 1, login: 'm', role: 'maintainer' },
  });
  requests = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.includes('/batches') || url.includes('/schedule/')) requests.push(url);
    return fixture.fetch(input, init);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(path: string, body: unknown) {
  const response = await fixture.handle(
    new Request(`https://worker.example${path}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  expect(response!.status).toBe(200);
  return (await response!.json()) as { batch: { id: string; revision: number } };
}

/** "December patch" with new English for 10 and 13 (13 is what 10 imports). */
async function seedBatch() {
  const { batch } = await call('/batches', { name: 'December patch' });
  const saved = await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 10, base: current[10], next: tooltip(10, 'Upcoming 10 import 13 from tooltip') },
      { hash: 13, base: current[13], next: tooltip(13, 'Upcoming 13') },
    ],
  });
  return saved.batch;
}

async function mount(role: 'maintainer' | 'translator' | 'trial', path = '/t/10') {
  const { TooltipPage } = await import('./TooltipPage');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDataStore } = await import('../../stores/data');
  const { useDraftStore } = await import('../../stores/drafts');
  const { disposeSteppingActivity } = await import('../navigation/steppingActivity');
  useDataStore.setState({ status: 'ready', data: data as never });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({
    user: { id: 1, login: 'm', role, languages: ['de'] },
    loading: false,
  });
  const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
    initialEntries: [path],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  // Lazy chunks, the fixture, and parsing resolve over several tasks (more under load): wait for
  // the condition, then a few more turns so effects it starts also land.
  const settle = async (done: () => boolean = () => true) => {
    for (let i = 0; i < 400 && !done(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    for (let i = 0; i < 8; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };
  const listings = () => fixture.log.filter((entry) => entry.path === '/batches').length;
  await settle(() => role === 'trial' || listings() > 0);
  const preview = () => host.querySelector<HTMLElement>('[data-preview]')!;
  /** The batch line as read (its title: the segments joined by the separators drawn between them). */
  const line = () => host.querySelector<HTMLElement>('[data-upcoming] p')?.title;
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  return {
    host,
    router,
    settle,
    preview,
    line,
    button,
    async dispose() {
      await act(async () => root.unmount());
      router.dispose();
      host.remove();
      disposeSteppingActivity();
    },
  };
}

it('switches the preview between current and the batch future state', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const page = await mount('maintainer');
  try {
    // A member: the switch above the preview and the badge in the pane header; Current first.
    expect(page.button('Current')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.host.textContent).toContain('Batch: December patch');
    expect(page.line()).toBe('December patch · Draft · No time set');
    expect(page.preview().dataset.text).toBe('English 10 import 13 from tooltip');
    expect(page.preview().dataset.import).toBe('English 13');
    // Upcoming: members are read once, then the page renders the future state (base, enhanced,
    // and imports through the same future state).
    await act(async () => page.button('Upcoming')!.click());
    await page.settle(() => page.preview().dataset.text?.startsWith('Upcoming') === true);
    expect(page.button('Upcoming')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.preview().dataset.text).toBe('Upcoming 10 import 13 from tooltip');
    expect(page.preview().dataset.enhanced).toBe('Upcoming 10 import 13 from tooltip');
    expect(page.preview().dataset.import).toBe('Upcoming 13');
    expect(page.preview().dataset.loading).toBe('false');
    expect(requests.filter((url) => url.includes('/tooltips/'))).toHaveLength(2);

    // A non-member: no switch, no badge, current text; the choice is kept for the next member.
    await act(async () => page.router.navigate('/t/12'));
    await page.settle();
    expect(page.button('Upcoming')).toBeUndefined();
    expect(page.host.textContent).not.toContain('December patch');
    expect(page.preview().dataset.text).toBe('English 12');
    await act(async () => page.router.navigate('/t/13'));
    await page.settle(() => page.preview().dataset.text === 'Upcoming 13');
    expect(page.preview().dataset.text).toBe('Upcoming 13');
    // Stepping between members of one batch reads nothing new.
    expect(requests.filter((url) => url.includes('/tooltips/'))).toHaveLength(2);

    // A batch change arriving while open: the next listing re-reads the members.
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [{ hash: 13, base: null, next: tooltip(13, 'Later 13') }],
    });
    const { refreshBatches } = await import('./UpcomingSwitch.load');
    await act(async () => refreshBatches());
    await page.settle(() => page.preview().dataset.text === 'Later 13');
    expect(page.preview().dataset.text).toBe('Later 13');

    // Scheduled: status and zoned time in the line.
    const scheduled = fixture.batches.get(batch.id)!;
    await call(`/batches/${batch.id}/schedule`, {
      revision: scheduled.revision,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'Europe/Berlin',
    });
    await act(async () => refreshBatches());
    await page.settle(() => page.host.textContent?.includes('Scheduled') === true);
    expect(page.line()).toMatch(/^December patch · Scheduled · Thu 3 Dec \d\d:00( · 16:00)? UTC$/);

    // Current saved moved under the batch: the line names the stale field.
    const { useDataStore } = await import('../../stores/data');
    await act(async () =>
      useDataStore.setState({
        data: {
          ...data,
          bundle: { ...data.bundle, tooltips: { ...current, 13: tooltip(13, 'Edited 13') } },
        } as never,
      }),
    );
    await page.settle();
    expect(page.line()).toMatch(/ · Current changed: English$/);
    expect(page.preview().dataset.text).toBe('Later 13');

    // Cancelled: no longer open, so the switch and badge go and Current renders.
    await call(`/batches/${batch.id}/cancel`, {
      revision: fixture.batches.get(batch.id)!.revision,
    });
    await act(async () => refreshBatches());
    await page.settle(() => page.button('Upcoming') === undefined);
    expect(page.button('Upcoming')).toBeUndefined();
    expect(page.preview().dataset.text).toBe('Edited 13');
    // The page only ever reads: listings and raw member files.
    expect(fixture.log.every((entry) => entry.method === 'GET')).toBe(true);
  } finally {
    await page.dispose();
  }
});

it('falls back to Current with Retry when the members cannot be read', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  await seedBatch();
  const page = await mount('translator', '/t/10?lang=en');
  try {
    const { setRawFetch } = await import('../../services/scheduled/api');
    setRawFetch(async () => new Response('down', { status: 503 }));
    await act(async () => page.button('Upcoming')!.click());
    await page.settle(() => page.host.textContent?.includes('did not load') === true);
    expect(page.host.textContent).toContain('Upcoming did not load');
    expect(page.button('Current')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.preview().dataset.text).toBe('English 10 import 13 from tooltip');
    setRawFetch(undefined);
    await act(async () => page.button('Retry')!.click());
    await page.settle(() => page.preview().dataset.text?.startsWith('Upcoming') === true);
    expect(page.preview().dataset.text).toBe('Upcoming 10 import 13 from tooltip');
  } finally {
    await page.dispose();
  }
});

it('requests nothing for a trial (Q3) or with the build switch OFF', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  await seedBatch();
  const trial = await mount('trial');
  try {
    expect(trial.button('Upcoming')).toBeUndefined();
    expect(requests).toEqual([]);
  } finally {
    await trial.dispose();
  }
  vi.resetModules();
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
  const off = await mount('maintainer');
  try {
    expect(off.button('Upcoming')).toBeUndefined();
    expect(off.host.textContent).not.toContain('December patch');
    expect(requests).toEqual([]);
  } finally {
    await off.dispose();
  }
});

it('renders an override the batch stages for a derived enhanced version', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const { batch } = await call('/batches', { name: 'Override patch' });
  await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 10, base: current[10], next: tooltip(10, 'Future base') },
      { hash: 11, base: current[11], next: tooltip(11, 'Future override') },
    ],
  });
  const page = await mount('maintainer');
  try {
    // Current: the enhanced version is derived and renders the base text.
    expect(page.preview().dataset.enhanced).toBe('English 10 import 13 from tooltip');
    await act(async () => page.button('Upcoming')!.click());
    await page.settle(() => page.preview().dataset.text === 'Future base');
    expect(page.preview().dataset.enhanced).toBe('Future override');
    // Current is unchanged by the future classification.
    await act(async () => page.button('Current')!.click());
    await page.settle();
    expect(page.preview().dataset.enhanced).toBe('English 10 import 13 from tooltip');
  } finally {
    await page.dispose();
  }
});
