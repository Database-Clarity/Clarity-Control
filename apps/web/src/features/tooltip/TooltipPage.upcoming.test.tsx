// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Lang, Tooltip } from '@clarity/core';
import type { PreviewColumnProps } from '../preview';
import {
  createBatchFixture,
  type BatchFixture,
} from '../../services/scheduled/fixtureWorker.testSupport';

const editorProps: {
  current?: {
    tooltipHash: number;
    value: string;
    sourceText?: string;
    readOnly: boolean;
    onChange(text: string): void;
  };
} = {};
vi.mock('../../services/save/validationWorker', () => ({
  requestSaveValidation: async (
    changes: import('../../services/api').Change[],
    data: import('../../stores/data').EditorData,
  ) => (await import('../../services/save/validation')).validateChanges(changes, data),
}));
vi.mock('../editor', () => ({
  ClarityEditor: (props: NonNullable<typeof editorProps.current>) => {
    editorProps.current = props;
    return <div data-editor={props.tooltipHash} />;
  },
}));
// The preview column is drawn by its own tests; here it reports what the page asked it to render.
const shownProps: { current?: PreviewColumnProps } = {};
vi.mock('../preview', () => ({
  PreviewColumn: (props: PreviewColumnProps) => {
    shownProps.current = props;
    return (
      <div
        data-preview=""
        data-text={props.baseText}
        data-enhanced={props.enhanced.map((view) => view.text).join('|')}
        data-import={props.baseGlobals.imports?.['13'] ?? ''}
        data-loading={String(Boolean(props.loadingContent))}
        data-mode={props.mode}
        data-variant={props.variant ?? ''}
      >
        {props.source}
      </div>
    );
  },
}));
vi.mock('../history/HistoryPanel', () => ({
  HistoryPanel: ({ readOnly }: { readOnly: boolean }) => (
    <div data-history-readonly={String(readOnly)} />
  ),
}));
vi.mock('../compendium/CompendiumPanel', () => ({
  CompendiumPanel: ({ base }: { base: Tooltip }) => (
    <div data-editable-compendium={base.text.en?.text} />
  ),
}));
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
  // A derived same-type copy: neither an enhanced pair nor an override, so Current previews it not.
  14: tooltip(14, 'English 10 import 13 from tooltip'),
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
    14: { hash: 14, name: 'A copy', icon: '', categoryId: 'perks', baseHash: 10 },
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
  expect(response!.ok).toBe(true);
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

async function mount(
  role: 'maintainer' | 'editor' | 'translator' | 'trial',
  path = '/t/10',
  state?: unknown,
  assigned: Lang[] = ['de'],
) {
  const { TooltipPage } = await import('./TooltipPage');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDataStore } = await import('../../stores/data');
  const { useDraftStore } = await import('../../stores/drafts');
  const { disposeSteppingActivity } = await import('../navigation/steppingActivity');
  useDataStore.setState({ status: 'ready', data: data as never });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({
    user: { id: 1, login: 'm', role, languages: assigned },
    loading: false,
  });
  const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
    initialEntries: [
      {
        pathname: path.split('?')[0],
        search: path.includes('?') ? `?${path.split('?')[1]}` : '',
        state,
      },
    ],
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

it('hides global inactive moves in both the header and grouped list during a batch visit', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const visit = await batchQueueFor(batch, 10);
  const page = await mount(
    'maintainer',
    (visit.first.detail as { path: string }).path,
    visit.state,
  );
  try {
    await page.settle();
    expect(document.querySelector('button[aria-label="Move to Inactive"]')).toBeNull();
    const grouped = document.querySelector<HTMLButtonElement>('button[aria-label^="Grouped "]');
    expect(grouped).not.toBeNull();
    await act(async () => grouped!.click());
    expect(document.querySelector('[data-grouped]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Move to Inactive"]')).toBeNull();
  } finally {
    await page.dispose();
  }
});

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

it('offers Upcoming when the batch holds only an enhanced version', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const { batch } = await call('/batches', { name: 'Enhanced only' });
  await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [{ hash: 11, base: current[11], next: tooltip(11, 'Future override') }],
  });
  for (const path of ['/t/11', '/t/10']) {
    const page = await mount('maintainer', path);
    try {
      expect(page.line()).toBe('Enhanced only · Draft · No time set');
      expect(page.host.textContent).toContain('Batch: Enhanced only');
      await act(async () => page.button('Upcoming')!.click());
      await page.settle(() => page.preview().dataset.enhanced === 'Future override');
      // The base is not in the batch: its current text, and no false "no batch file" failure.
      expect(page.preview().dataset.text).toBe('English 10 import 13 from tooltip');
      expect(page.preview().dataset.enhanced).toBe('Future override');
      expect(page.button('Retry')).toBeUndefined();
    } finally {
      await page.dispose();
    }
  }
});

it('selects and shows a version the batch adds in Upcoming', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const { batch } = await call('/batches', { name: 'Copy override' });
  await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 10, base: current[10], next: tooltip(10, 'Future base') },
      { hash: 14, base: current[14], next: tooltip(14, 'Future copy override') },
    ],
  });
  const page = await mount('maintainer');
  try {
    expect(page.preview().dataset.enhanced).toBe('English 10 import 13 from tooltip');
    await act(async () => page.button('Upcoming')!.click());
    await page.settle(() => page.preview().dataset.text === 'Future base');
    expect(page.preview().dataset.enhanced).toBe('Future base|Future copy override');
    await act(async () => {
      shownProps.current!.onVariant(14);
      shownProps.current!.onMode('enhanced');
    });
    await page.settle();
    expect(page.preview().dataset.mode).toBe('enhanced');
    expect(page.preview().dataset.variant).toBe('14');
    // Back on Current the copy is not previewed: the selection falls back to the enhanced pair.
    await act(async () => page.button('Current')!.click());
    await page.settle();
    expect(page.preview().dataset.enhanced).toBe('English 10 import 13 from tooltip');
    expect(page.preview().dataset.variant).toBe('11');
  } finally {
    await page.dispose();
  }
});

it('routes an active batch queue into its own drafts and English, then leaves back to Current', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const { useWorkQueues } = await import('../queue/store');
  const { useBatchDraftStore, batchDraftKey } =
    await import('../../services/scheduled/batchDrafts');
  const { useDraftStore } = await import('../../stores/drafts');
  await useBatchDraftStore.getState().activate('1');
  const key = `${batch.id}:10:de`;
  useWorkQueues.getState().start({
    version: 1,
    id: 'batch-route',
    source: 'translations',
    scope: 'shown',
    origin: { path: '/translations', restore: {} },
    items: [
      {
        key,
        hash: 10,
        lang: 'de',
        name: 'A base',
        detail: { path: '/t/10?lang=de', batchId: batch.id },
      },
    ],
    skipped: [],
    current: key,
    finished: false,
    createdAt: Date.now(),
    destination: { kind: 'batch', batchId: batch.id, batchName: 'December patch' } as never,
  });
  const page = await mount('translator', '/t/10?lang=de', {
    workThrough: { id: 'batch-route', key },
  });
  try {
    await page.settle(
      () =>
        editorProps.current?.sourceText?.startsWith('Upcoming 10') === true &&
        !editorProps.current.readOnly,
    );
    expect(editorProps.current?.sourceText).toBe('Upcoming 10 import 13 from tooltip');
    expect(editorProps.current?.readOnly).toBe(false);
    expect(page.host.textContent).toContain('Upcoming English');
    expect(page.host.textContent).not.toContain('Edits here save to Current');
    await act(async () => editorProps.current!.onChange('Batch German'));
    const draft = useBatchDraftStore.getState().drafts[batchDraftKey(batch.id, 10)]!;
    expect(draft.next.text.de?.text).toBe('Batch German');
    expect(draft.next.text.de?.sourceUpdatedAt).toBe(draft.base.text.en?.updatedAt);
    await page.settle(() => page.host.textContent!.includes('Queue done'));
    expect(page.host.textContent).toContain('Queue done');
    await act(async () => useBatchDraftStore.getState().discardAt(batchDraftKey(batch.id, 10)));
    await page.settle(() => page.host.textContent!.includes('1 of 1'));
    expect(page.host.textContent).toContain('1 of 1');
    await act(async () => editorProps.current!.onChange('Batch German'));
    expect(useDraftStore.getState().drafts).toEqual({});
    const state = page.router.state.location.state;
    await act(async () => page.router.navigate('/t/10?lang=fr', { state }));
    await page.settle(() => editorProps.current?.readOnly === true);
    expect(editorProps.current?.readOnly).toBe(true);
    await act(async () => editorProps.current!.onChange('Unassigned French'));
    expect(
      useBatchDraftStore.getState().drafts[batchDraftKey(batch.id, 10)]!.next.text.fr,
    ).toBeUndefined();
    await act(async () => page.router.navigate('/t/10?lang=de', { state }));
    await page.settle(() => editorProps.current?.readOnly === false);
    const previousChange = editorProps.current!.onChange;
    const { upcomingStore } = await import('./UpcomingSwitch.store');
    await act(async () => upcomingStore().setState({ memberOf: {}, loads: {} }));
    await page.settle(() => editorProps.current?.readOnly === true);
    expect(editorProps.current?.readOnly).toBe(true);
    await act(async () => previousChange('A late edit after closure'));
    expect(
      useBatchDraftStore.getState().drafts[batchDraftKey(batch.id, 10)]!.next.text.de?.text,
    ).toBe('Batch German');
    expect(useDraftStore.getState().drafts).toEqual({});
    await act(async () => page.router.navigate('/t/10?lang=de'));
    await page.settle(() => editorProps.current?.sourceText?.startsWith('English 10') === true);
    expect(editorProps.current?.value).toBe('');
    expect(useBatchDraftStore.getState().drafts[batchDraftKey(batch.id, 10)]).toBeDefined();
  } finally {
    await page.dispose();
  }
});

it('keeps a batch-derived enhanced preview derived while its base translation is drafted', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 11, base: current[11], next: tooltip(11, 'Upcoming 10 import 13 from tooltip') },
    ],
  });
  const { useWorkQueues } = await import('../queue/store');
  const { useBatchDraftStore } = await import('../../services/scheduled/batchDrafts');
  await useBatchDraftStore.getState().activate('1');
  const key = `${batch.id}:10:de`;
  useWorkQueues.getState().start({
    version: 1,
    id: 'batch-variants',
    source: 'translations',
    scope: 'shown',
    origin: { path: '/translations', restore: {} },
    items: [
      {
        key,
        hash: 10,
        lang: 'de',
        name: 'A base',
        detail: { path: '/t/10?lang=de', batchId: batch.id },
      },
    ],
    skipped: [],
    current: key,
    finished: false,
    createdAt: Date.now(),
    destination: { kind: 'batch', batchId: batch.id, batchName: 'December patch' },
  });
  const page = await mount('translator', '/t/10?lang=de', {
    workThrough: { id: 'batch-variants', key },
  });
  try {
    await page.settle(() => !editorProps.current?.readOnly);
    await act(async () => editorProps.current!.onChange('Batch German'));
    await page.settle(() => page.preview().dataset.enhanced === 'Batch German');
    expect(page.preview().dataset.enhanced).toBe('Batch German');
    // Drafting changes no saved batch member or Current tooltip.
    expect(fixture.members.get(batch.id)?.get(11)?.proposed.text.de).toBeUndefined();
  } finally {
    await page.dispose();
  }
});

it('keeps the active batch destination on de to fr and saves the next edit only to that batch', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const { useWorkQueues } = await import('../queue/store');
  const { useBatchDraftStore, batchDraftKey } =
    await import('../../services/scheduled/batchDrafts');
  const { useDraftStore } = await import('../../stores/drafts');
  const { useDataStore } = await import('../../stores/data');
  await useBatchDraftStore.getState().activate('1');
  const key = `${batch.id}:10:de`;
  useWorkQueues.getState().start({
    version: 1,
    id: 'batch-language',
    source: 'translations',
    scope: 'shown',
    origin: { path: '/translations', restore: { language: 'de' } },
    items: [
      {
        key,
        hash: 10,
        lang: 'de',
        name: 'A base',
        detail: { path: '/t/10?lang=de', batchId: batch.id },
      },
    ],
    skipped: [],
    current: key,
    finished: false,
    createdAt: Date.now(),
    destination: { kind: 'batch', batchId: batch.id, batchName: 'December patch' },
  });
  fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] });
  const state = { workThrough: { id: 'batch-language', key } };
  const page = await mount('translator', '/t/10?lang=de', state, ['de', 'fr']);
  try {
    await page.settle(() => editorProps.current?.readOnly === false);
    const select = page.host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    await act(async () => {
      select.value = 'fr';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.settle(
      () =>
        new URLSearchParams(page.router.state.location.search).get('lang') === 'fr' &&
        editorProps.current?.readOnly === false,
    );
    expect(page.router.state.location.state).toEqual(state);
    expect(page.host.querySelector('[title*="Edits here save to December patch"]')).not.toBeNull();
    expect(useWorkQueues.getState().queues['batch-language']!.items[0]!.lang).toBe('de');
    await act(async () => editorProps.current!.onChange('Français pour le lot'));
    expect(
      useBatchDraftStore.getState().drafts[batchDraftKey(batch.id, 10)]!.next.text.fr?.text,
    ).toBe('Français pour le lot');
    const before = fixture.log.length;
    await act(async () => page.button('Save batch')!.click());
    await page.settle(
      () =>
        fixture.members.get(batch.id)?.get(10)?.proposed.text.fr?.text === 'Français pour le lot',
    );
    expect(fixture.members.get(batch.id)?.get(10)?.proposed.text.fr?.text).toBe(
      'Français pour le lot',
    );
    expect(
      fixture.log
        .slice(before)
        .filter((entry) => entry.method === 'POST')
        .map((entry) => entry.path),
    ).toEqual([`/batches/${batch.id}/save`]);
    expect(useDraftStore.getState().drafts).toEqual({});
    expect(useDataStore.getState().data!.bundle.tooltips[10]!.text.fr).toBeUndefined();
    await act(async () => {
      select.value = 'es';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.settle(() => editorProps.current?.readOnly === true);
    expect(editorProps.current?.readOnly).toBe(true);
    expect(page.router.state.location.state).toEqual(state);
  } finally {
    await page.dispose();
  }
});

it.each(['maintainer', 'editor', 'translator'] as const)(
  'keeps History Restore and editable Compendium out of a %s batch visit',
  async (role) => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const batch = await seedBatch();
    const { useWorkQueues } = await import('../queue/store');
    const { useBatchDraftStore } = await import('../../services/scheduled/batchDrafts');
    const { useDraftStore } = await import('../../stores/drafts');
    await useBatchDraftStore.getState().activate('1');
    const key = `${batch.id}:10:de`;
    useWorkQueues.getState().start({
      version: 1,
      id: 'batch-panes',
      source: 'translations',
      scope: 'shown',
      origin: { path: '/translations', restore: {} },
      items: [{ key, hash: 10, lang: 'de', name: 'A base', detail: { batchId: batch.id } }],
      skipped: [],
      current: key,
      finished: false,
      createdAt: Date.now(),
      destination: { kind: 'batch', batchId: batch.id, batchName: 'December patch' },
    });
    const page = await mount(role, '/t/10?lang=de', {
      workThrough: { id: 'batch-panes', key },
    });
    try {
      await page.settle(() => editorProps.current?.sourceText?.startsWith('Upcoming') === true);
      expect(page.host.querySelector('[data-history-readonly="true"]')).not.toBeNull();
      const compendium = () =>
        [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent === 'Compendium',
        )!;
      await act(async () => compendium().click());
      await page.settle(() => !!page.host.querySelector('[data-saved-compendium]'));
      expect(page.host.querySelector('[data-saved-compendium]')).not.toBeNull();
      expect(page.host.querySelector('[data-editable-compendium]')).toBeNull();
      expect(useDraftStore.getState().drafts).toEqual({});
      // Leaving the queue restores the existing Current-pane permissions and Current base.
      await act(async () => page.router.navigate('/t/10?lang=de'));
      await page.settle(() => !!page.host.querySelector('[data-history-readonly="false"]'));
      expect(page.host.querySelector('[data-history-readonly="false"]')).not.toBeNull();
      await act(async () => compendium().click());
      await page.settle();
      if (role === 'translator') {
        expect(page.host.querySelector('[data-saved-compendium]')).not.toBeNull();
        expect(page.host.querySelector('[data-editable-compendium]')).toBeNull();
      } else {
        expect(
          page.host
            .querySelector('[data-editable-compendium]')
            ?.getAttribute('data-editable-compendium'),
        ).toBe('English 10 import 13 from tooltip');
      }
      expect(useDraftStore.getState().drafts).toEqual({});
    } finally {
      await page.dispose();
    }
  },
);

it('keeps ordinary Current queue language switching unchanged', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const { useWorkQueues } = await import('../queue/store');
  useWorkQueues.getState().start({
    version: 1,
    id: 'current-language',
    source: 'translations',
    scope: 'shown',
    origin: { path: '/translations', restore: {} },
    items: [
      { key: '10:de', hash: 10, lang: 'de', name: 'A base', detail: { path: '/t/10?lang=de' } },
    ],
    skipped: [],
    current: '10:de',
    finished: false,
    createdAt: Date.now(),
    destination: null,
  });
  const page = await mount('maintainer', '/t/10?lang=de', {
    workThrough: { id: 'current-language', key: '10:de' },
  });
  try {
    const select = page.host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    await act(async () => {
      select.value = 'fr';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.settle();
    expect(page.router.state.location.state).toBeNull();
    expect(editorProps.current?.readOnly).toBe(false);
  } finally {
    await page.dispose();
  }
});

async function batchQueueFor(batch: { id: string }, firstHash: number) {
  const { upcomingRows } = await import('../translations/upcoming');
  const { upcomingState } = await import('./UpcomingSwitch.load');
  const { upcomingItem } = await import('../queue/startUpcoming');
  const { useWorkQueues } = await import('../queue/store');
  const { useBatchDraftStore } = await import('../../services/scheduled/batchDrafts');
  await useBatchDraftStore.getState().activate('1');
  const members = [...fixture.members.get(batch.id)!.values()];
  const open = { ...fixture.batches.get(batch.id)!, hashes: members.map((m) => m.hash) };
  const items = upcomingRows(
    data as never,
    [{ batch: open as never, upcoming: upcomingState(members, data as never) }],
    'de',
  ).map((row) => upcomingItem(row, data as never));
  const first = items.find((item) => item.hash === firstHash)!;
  const queue = {
    version: 1 as const,
    id: 'member-route',
    source: 'translations' as const,
    scope: 'shown' as const,
    origin: { path: '/translations', restore: { language: 'de', query: '', category: null } },
    items,
    skipped: [],
    current: first.key,
    finished: false,
    createdAt: Date.now(),
    destination: { kind: 'batch' as const, batchId: batch.id, batchName: 'December patch' },
  };
  useWorkQueues.getState().start(queue);
  return { queue, first, state: { workThrough: { id: queue.id, key: first.key } } };
}

it.each([false, true])(
  'opens and saves the exact future override member (base present: %s)',
  async (both) => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const { batch } = await call('/batches', { name: 'December patch' });
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [
        ...(both ? [{ hash: 10, base: current[10], next: tooltip(10, 'Future base') }] : []),
        { hash: 11, base: current[11], next: tooltip(11, 'Future override') },
      ],
    });
    const visit = await batchQueueFor(batch, both ? 10 : 11);
    const page = await mount(
      'translator',
      (visit.first.detail as { path: string }).path,
      visit.state,
    );
    try {
      await page.settle(() => editorProps.current?.readOnly === false);
      if (both) {
        await act(async () =>
          page.host.querySelector<HTMLAnchorElement>('a[aria-label^="Next in queue:"]')!.click(),
        );
      }
      await page.settle(
        () => editorProps.current?.tooltipHash === 11 && !editorProps.current.readOnly,
      );
      expect(page.router.state.location.search).toContain('variant=11');
      expect(editorProps.current?.tooltipHash).toBe(11);
      expect(editorProps.current?.sourceText).toBe('Future override');
      const { rebuild } = await import('../queue/batchQueue');
      const { useAuthStore } = await import('../../stores/auth');
      const rebuilt = await rebuild(visit.queue, {
        data: data as never,
        user: useAuthStore.getState().user!,
        decisions: {},
      });
      expect((rebuilt.find((item) => item.hash === 11)!.detail as { path: string }).path).toBe(
        '/t/10?lang=de&variant=11',
      );
      await act(async () => editorProps.current!.onChange('German for enhanced 11'));
      const { saveBatchDrafts } = await import('./batchDestination.live');
      await act(async () => {
        await saveBatchDrafts(batch.id);
      });
      expect(fixture.members.get(batch.id)?.get(11)?.proposed.text.de?.text).toBe(
        'German for enhanced 11',
      );
      expect(fixture.members.get(batch.id)?.get(10)?.proposed.text.de).toBeUndefined();
    } finally {
      await page.dispose();
    }
  },
);

it('keeps moved Current German visible while a French batch draft is authored and saved', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const visit = await batchQueueFor(batch, 10);
  fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] });
  const page = await mount(
    'translator',
    (visit.first.detail as { path: string }).path,
    visit.state,
    ['de', 'fr'],
  );
  try {
    const { useDataStore } = await import('../../stores/data');
    const moved = {
      ...current[10],
      text: { ...current[10].text, de: { text: 'Current German moved after base', ...stamp } },
    };
    fixture.setCurrent(10, moved);
    await act(async () =>
      useDataStore.setState({
        data: { ...data, bundle: { ...data.bundle, tooltips: { ...current, 10: moved } } } as never,
      }),
    );
    await page.settle(() => editorProps.current?.value === moved.text.de.text);
    expect(editorProps.current?.value).toBe(moved.text.de.text);
    const select = page.host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    const language = async (lang: string) => {
      await act(async () => {
        select.value = lang;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.settle();
    };
    await language('fr');
    await act(async () => editorProps.current!.onChange('French batch rework'));
    await language('de');
    expect(editorProps.current?.value).toBe(moved.text.de.text);
    const { saveBatchDrafts } = await import('./batchDestination.live');
    await act(async () => {
      await saveBatchDrafts(batch.id);
    });
    const saved = fixture.members.get(batch.id)!.get(10)!;
    expect(saved.proposed.text.de).toBeUndefined();
    expect(saved.proposed.text.fr?.text).toBe('French batch rework');
  } finally {
    await page.dispose();
  }
});
it('keeps newer batch German visible while French is drafted and saved', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const batch = await seedBatch();
  const visit = await batchQueueFor(batch, 10);
  fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] });
  const page = await mount(
    'translator',
    (visit.first.detail as { path: string }).path,
    visit.state,
    ['de', 'fr'],
  );
  try {
    await page.settle(() => editorProps.current?.readOnly === false);
    const language = async (lang: string) => {
      const select = page.host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
      await act(async () => {
        select.value = lang;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.settle();
    };
    await language('fr');
    await act(async () => editorProps.current!.onChange('Local French rework'));
    const old = fixture.members.get(batch.id)!.get(10)!;
    fixture.setUser({ id: 1, login: 'm', role: 'maintainer' });
    await call(`/batches/${batch.id}/save`, {
      revision: fixture.batches.get(batch.id)!.revision,
      changes: [
        {
          hash: 10,
          base: old.proposed,
          next: {
            ...old.proposed,
            text: { ...old.proposed.text, de: { ...stamp, text: 'New German saved by colleague' } },
          },
        },
      ],
    });
    fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] });
    const { refreshBatches } = await import('./UpcomingSwitch.load');
    const { upcomingStore } = await import('./UpcomingSwitch.store');
    const revision = fixture.batches.get(batch.id)!.revision;
    await act(async () => refreshBatches());
    await page.settle(() => {
      const load = upcomingStore().getState().loads[batch.id];
      return load?.state === 'ready' && load.revision === revision;
    });
    await language('de');
    const load = upcomingStore().getState().loads[batch.id]!;
    if (load.state !== 'ready') throw Error('not ready');
    const displayed = editorProps.current?.value;
    const loaded = load.upcoming.overlay[10]!.next.text.de?.text;
    const { saveBatchDrafts } = await import('./batchDestination.live');
    let notice = '';
    await act(async () => {
      notice = await saveBatchDrafts(batch.id);
    });
    const saved = fixture.members.get(batch.id)!.get(10)!;
    expect(notice).toContain('Saved 1 tooltip');
    expect(saved.proposed.text.de?.text).toBe(loaded);
    expect(saved.proposed.text.fr?.text).toBe('Local French rework');
    expect(displayed).toBe(loaded);
  } finally {
    await page.dispose();
  }
});

it('shows the needs-updating banner from the Current draft, and from the batch draft in a batch', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  const day = (n: number) => new Date(Date.parse(stamp.updatedAt) + n * 86_400_000).toISOString();
  const german = {
    ...current[10],
    text: {
      ...current[10].text,
      de: { text: 'Deutsch 10', ...stamp, sourceUpdatedAt: day(-100) },
    },
  };
  fixture.setCurrent(10, german);
  const { batch } = await call('/batches', { name: 'December patch' });
  const future = { text: 'Upcoming 10', updatedAt: day(1), updatedBy: 'a' };
  await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 10, base: german, next: { ...german, text: { ...german.text, en: future } } },
    ],
  });
  const visit = await batchQueueFor(batch, 10);
  const page = await mount('translator', '/t/10?lang=de');
  const { useDataStore } = await import('../../stores/data');
  const { useDraftStore } = await import('../../stores/drafts');
  const { useBatchDraftStore } = await import('../../services/scheduled/batchDrafts');
  const row = () => page.host.querySelector<HTMLElement>('[data-translation-row]');
  const text = () => row()!.querySelector('p span')?.textContent ?? null;
  const type = async (value: string) => {
    await act(async () => editorProps.current!.onChange(value));
    await page.settle();
  };
  const behind = (days: number) =>
    `Published in English until this is updated: the translation is ${days} days behind`;
  try {
    const saved = (tooltip: Tooltip) =>
      act(async () =>
        useDataStore.setState({
          data: {
            ...data,
            bundle: { ...data.bundle, tooltips: { ...current, 10: tooltip } },
          } as never,
        }),
      );
    await saved(german);
    await page.settle(() => editorProps.current?.value === 'Deutsch 10');
    expect(text()).toBe(behind(100));
    await type('Neues Deutsch 10');
    expect(text()).toBeNull();
    await type('Deutsch 10'); // Undo to the stored text.
    expect(text()).toBe(behind(100));
    await type('Neues Deutsch 10');
    await act(async () => useDraftStore.getState().discard(10));
    await page.settle();
    expect(text()).toBe(behind(100));

    // Queue mode with the batch as its destination: the batch's English and drafts decide.
    await act(async () =>
      page.router.navigate((visit.first.detail as { path: string }).path, { state: visit.state }),
    );
    await page.settle(
      () => editorProps.current?.sourceText === 'Upcoming 10' && !editorProps.current.readOnly,
    );
    expect(text()).toBe(behind(101));
    await type('Stapel-Deutsch 10');
    expect(text()).toBeNull();
    await act(async () => useBatchDraftStore.setState({ drafts: {} }));
    await page.settle();
    expect(text()).toBe(behind(101));

    // English has no such line; its line is kept, empty, for a current translation.
    await act(async () => page.router.navigate('/t/10?lang=en'));
    await page.settle();
    expect(row()).toBeNull();
    await saved({
      ...german,
      text: { ...german.text, de: { ...german.text.de, sourceUpdatedAt: stamp.updatedAt } },
    });
    await act(async () => page.router.navigate('/t/10?lang=de'));
    await page.settle();
    expect(row()).not.toBeNull();
    expect(text()).toBeNull();
  } finally {
    await page.dispose();
  }
});
