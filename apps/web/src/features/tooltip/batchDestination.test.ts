// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createBatchFixture } from '../../services/scheduled/fixtureWorker.testSupport';
import { editorData, tooltip } from '../../services/save/fixtures.testSupport';

vi.mock('../../services/save/validationWorker', () => ({
  requestSaveValidation: async (
    changes: import('../../services/api').Change[],
    data: import('../../stores/data').EditorData,
  ) => (await import('../../services/save/validation')).validateChanges(changes, data),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  for (const name of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(async () => {
  // Drain save-triggered reloads and storage writes before the next test opens this bucket.
  const { refreshBatches } = await import('./UpcomingSwitch.load');
  const { useBatchDraftStore } = await import('../../services/scheduled/batchDrafts');
  await refreshBatches();
  await useBatchDraftStore.getState().activate(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(movedGerman?: string) {
  const current = { ...tooltip, text: { en: { ...tooltip.text.en!, text: 'Current English' } } };
  const future: Tooltip = {
    ...current,
    text: {
      en: { ...current.text.en!, text: 'Batch English', updatedAt: '2026-11-14T12:00:00.000Z' },
    },
  };
  const fixture = createBatchFixture({
    current: { 123: current },
    user: { id: 1, login: 'm', role: 'maintainer' },
  });
  vi.stubGlobal('fetch', fixture.fetch);
  const api = await import('../../services/scheduled/api');
  const { batch } = await api.createBatch('December patch');
  await api.saveToBatch(
    batch.id,
    batch.revision,
    'draft',
    [{ hash: 123, base: current, next: future }],
    '',
  );
  const shownCurrent: Tooltip = movedGerman
    ? {
        ...current,
        text: {
          ...current.text,
          de: {
            text: movedGerman,
            updatedAt: '2026-11-14T12:30:00.000Z',
            updatedBy: 'other-translator',
            sourceUpdatedAt: current.text.en!.updatedAt,
          },
        },
      }
    : current;
  if (movedGerman) fixture.setCurrent(123, shownCurrent);
  const { useDataStore } = await import('../../stores/data');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDraftStore } = await import('../../stores/drafts');
  const { useBatchDraftStore, batchDraftKey } =
    await import('../../services/scheduled/batchDrafts');
  const loader = await import('./UpcomingSwitch.load');
  const { upcomingStore } = await import('./UpcomingSwitch.store');
  const runtime = await import('./batchDestination.live');
  const data = editorData();
  data.bundle.tooltips[123] = shownCurrent;
  useDataStore.setState({ data, status: 'ready' });
  useAuthStore.setState({
    user: { id: 1, login: 'm', role: 'translator', languages: ['de'] },
    loading: false,
    token: null,
  });
  fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de'] });
  await useBatchDraftStore.getState().activate('1');
  useBatchDraftStore.setState({ drafts: {} });
  useDraftStore.setState({
    drafts: {
      123: {
        base: current,
        next: { ...current, text: { en: { ...current.text.en!, text: 'Current local draft' } } },
      },
    },
  });
  const before = useDraftStore.getState().drafts;
  const saved = data.bundle.tooltips;
  await loader.refreshBatches();
  loader.ensureBatch(batch.id);
  await vi.waitFor(() => expect(upcomingStore().getState().loads[batch.id]?.state).toBe('ready'));
  return {
    current: shownCurrent,
    future,
    fixture,
    batch,
    runtime,
    useDataStore,
    useDraftStore,
    useBatchDraftStore,
    batchDraftKey,
    before,
    saved,
    upcomingStore,
    loader,
  };
}

it('saves only batch text, preserving Current saved and draft bytes, with future English attribution', async () => {
  const s = await setup();
  s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'German for the batch', 'm');
  const draft = s.useBatchDraftStore.getState().drafts[s.batchDraftKey(s.batch.id, 123)]!;
  expect(draft.next.text.de?.sourceUpdatedAt).toBe(s.future.text.en?.updatedAt);
  expect(await s.runtime.saveBatchDrafts(s.batch.id)).toContain(
    'Saved 1 tooltip to December patch',
  );
  expect(s.fixture.members.get(s.batch.id)?.get(123)?.proposed.text.de?.text).toBe(
    'German for the batch',
  );
  expect(s.useBatchDraftStore.getState().drafts).toEqual({});
  expect(s.useDraftStore.getState().drafts).toBe(s.before);
  expect(s.useDataStore.getState().data!.bundle.tooltips).toBe(s.saved);
  expect(
    s.fixture.log
      .filter((entry) => entry.method === 'POST')
      .every((entry) => entry.path.startsWith('/batches')),
  ).toBe(true);
});

it('a closed batch retains its drafts and refuses a save', async () => {
  const s = await setup();
  s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'Kept German', 'm');
  const before = s.useBatchDraftStore.getState().drafts;
  s.upcomingStore().setState({ memberOf: {}, loads: {} });
  await expect(s.runtime.saveBatchDrafts(s.batch.id)).rejects.toThrow(/editable|Reload/);
  expect(s.useBatchDraftStore.getState().drafts).toBe(before);
  expect(s.useDraftStore.getState().drafts).toBe(s.before);
});

it('restoring the shown future translation leaves no phantom change or new source stamp', async () => {
  const s = await setup('Current German after the batch base');
  const { useAuthStore } = await import('../../stores/auth');
  const { upcomingRowState } = await import('../translations/upcoming');
  useAuthStore.setState({
    user: { id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] },
  });
  s.fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de', 'fr'] });
  const load = s.upcomingStore().getState().loads[s.batch.id]!;
  if (load.state !== 'ready') throw new Error('Batch did not load');
  const future = load.upcoming.overlay[123]!.next;
  const member = load.upcoming.members[123]!;
  const key = s.batchDraftKey(s.batch.id, 123);
  expect(future.text.de).toEqual(s.current.text.de);
  expect(upcomingRowState(member, s.current, future, 'de').state).toBe('needs');
  const edit = (language: 'de' | 'fr', text: string) =>
    s.runtime.edit(s.batch.id, member.proposed, future, language, text, 'm');
  edit('de', 'Temporary German rework');
  expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de?.text).toBe(
    'Temporary German rework',
  );
  edit('de', future.text.de!.text);
  expect(s.useBatchDraftStore.getState().drafts[key]).toBeUndefined();
  // Restoring German must also leave other authored languages intact during the same save.
  edit('fr', 'Français pour le lot');
  edit('de', 'Another temporary rework');
  edit('de', future.text.de!.text);
  expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de).toEqual(
    member.proposed.text.de,
  );
  expect(await s.runtime.saveBatchDrafts(s.batch.id)).toContain('Saved 1 tooltip');
  const savedMember = s.fixture.members.get(s.batch.id)!.get(123)!;
  expect(savedMember.proposed.text.de).toEqual(member.proposed.text.de);
  expect(savedMember.proposed.text.fr?.text).toBe('Français pour le lot');
  const savedFuture = s.loader.upcomingState([savedMember], s.useDataStore.getState().data!)
    .overlay[123]!.next;
  expect(savedFuture.text.de).toEqual(s.current.text.de);
  expect(upcomingRowState(savedMember, s.current, savedFuture, 'de').state).toBe('needs');
  expect(s.useDraftStore.getState().drafts).toBe(s.before);
  expect(s.useDataStore.getState().data!.bundle.tooltips).toBe(s.saved);
});

it('reconciles a confirmed save even when the local preview update fails', async () => {
  const s = await setup();
  const { saveReviewToBatch } = await import('../review/batches/saveDestination');
  s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'Confirmed German', 'm');
  const notice = await saveReviewToBatch(
    { kind: 'batch', id: s.batch.id },
    [],
    '',
    {},
    () => true,
    async (changes) => changes,
    () => {
      throw new Error('Local preview failed');
    },
  );
  expect(notice).toContain('Saved 1 tooltip to December patch');
  expect(notice).toContain('Reload to see them.');
  expect(s.fixture.members.get(s.batch.id)?.get(123)?.proposed.text.de?.text).toBe(
    'Confirmed German',
  );
  expect(s.useBatchDraftStore.getState().drafts).toEqual({});
  expect(s.useDraftStore.getState().drafts).toBe(s.before);
  expect(s.useDataStore.getState().data!.bundle.tooltips).toBe(s.saved);
});

it('a queued save keeps its drafts until the preparer lands it, and on failure', async () => {
  vi.stubEnv('VITE_SCHEDULE_PREPARATION', '1');
  // Node environment: the Batches listing timer only needs focus listeners.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const s = await setup();
  const { refreshBatches } = await import('../review/batches/store');
  const { resetQueued } = await import('../review/batches/saveDestination');
  const key = s.batchDraftKey(s.batch.id, 123);
  const settled = () =>
    new Promise((resolve) => setTimeout(resolve, 0)).then(() => refreshBatches());
  try {
    s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'Queued German', 'm');
    expect(await s.runtime.saveBatchDrafts(s.batch.id)).toBe(
      'Save queued to December patch: 1 tooltip preparing. Drafts stay until the save lands.',
    );
    const [first] = [...s.fixture.requests.keys()];
    expect(s.fixture.batches.get(s.batch.id)?.status).toBe('preparing');
    expect(s.fixture.members.get(s.batch.id)?.get(123)?.proposed.text.de).toBeUndefined();
    await settled();
    expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de?.text).toBe('Queued German');
    // A failure (and its Edit back to draft) keeps the draft: nothing landed.
    s.fixture.failRequest(first, [{ reason: 'Runner lost' }], true);
    await settled();
    expect(s.useBatchDraftStore.getState().drafts[key]).toBeDefined();
    // Retry, then the preparer lands it: only now does the draft drop.
    s.fixture.setUser({ id: 1, login: 'm', role: 'maintainer' });
    const api = await import('../../services/scheduled/api');
    await api.retryBatchRequest(s.batch.id, s.fixture.batches.get(s.batch.id)!.revision, first);
    s.fixture.completeRequest(first);
    // Member reads fail while raw GitHub is down: tracking and drafts stay, and the first listing
    // after it recovers confirms them (code review round 1, finding 3).
    let rawDown = true;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (rawDown && new Request(input, init).url.includes('/tooltips/'))
        return Promise.resolve(new Response('busy', { status: 503 }));
      return s.fixture.fetch(input, init);
    });
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de?.text).toBe('Queued German');
    rawDown = false;
    await settled();
    await vi.waitFor(() => expect(s.useBatchDraftStore.getState().drafts[key]).toBeUndefined());
    expect(s.fixture.members.get(s.batch.id)?.get(123)?.proposed.text.de?.text).toBe(
      'Queued German',
    );
    expect(s.useDraftStore.getState().drafts).toBe(s.before);
    expect(s.useDataStore.getState().data!.bundle.tooltips).toBe(s.saved);
  } finally {
    resetQueued();
  }
});

it('a failed translator save into a scheduled batch keeps the drafts; the batch stays scheduled', async () => {
  vi.stubEnv('VITE_SCHEDULE_PREPARATION', '1');
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const s = await setup();
  const { refreshBatches } = await import('../review/batches/store');
  const { resetQueued } = await import('../review/batches/saveDestination');
  const key = s.batchDraftKey(s.batch.id, 123);
  try {
    // An editor schedules the batch (synchronously here), then the translator saves into it.
    s.fixture.setUser({ id: 2, login: 'e', role: 'editor' });
    const schedule = await s.fixture.handle(
      new Request(`https://worker.example/batches/${s.batch.id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          revision: s.fixture.batches.get(s.batch.id)!.revision,
          notBefore: '2026-12-01T10:00:00.000Z',
          zone: 'UTC',
        }),
      }),
    );
    expect(schedule!.status).toBe(202);
    s.fixture.setUser({ id: 1, login: 'm', role: 'translator', languages: ['de'] });
    await s.loader.refreshBatches();
    s.loader.ensureBatch(s.batch.id);
    await vi.waitFor(() => {
      const state = s.upcomingStore().getState();
      const load = state.loads[s.batch.id];
      expect(load?.state).toBe('ready');
      expect(load?.revision).toBe(state.memberOf[123]?.revision);
    });
    s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'Rejected German', 'm');
    expect(await s.runtime.saveBatchDrafts(s.batch.id)).toContain('Save queued');
    const [requestId] = [...s.fixture.requests.keys()];
    s.fixture.failSaveKeepScheduled(requestId, [{ reason: 'stamp is older than English' }]);
    await refreshBatches();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await refreshBatches();
    expect(s.fixture.batches.get(s.batch.id)?.status).toBe('scheduled');
    expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de?.text).toBe('Rejected German');
    expect(s.fixture.members.get(s.batch.id)?.get(123)?.proposed.text.de).toBeUndefined();
  } finally {
    resetQueued();
  }
});

it('a queued save that is cancelled keeps its drafts and stops tracking', async () => {
  vi.stubEnv('VITE_SCHEDULE_PREPARATION', '1');
  // Node environment: the Batches listing timer only needs focus listeners.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const s = await setup();
  const { refreshBatches } = await import('../review/batches/store');
  const key = s.batchDraftKey(s.batch.id, 123);
  s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'Cancelled German', 'm');
  await s.runtime.saveBatchDrafts(s.batch.id);
  s.fixture.setUser({ id: 1, login: 'm', role: 'maintainer' });
  const api = await import('../../services/scheduled/api');
  await api.endBatchSchedule(s.batch.id, s.fixture.batches.get(s.batch.id)!.revision, 'unschedule');
  await refreshBatches();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.fixture.batches.get(s.batch.id)?.status).toBe('draft');
  expect(s.useBatchDraftStore.getState().drafts[key]?.next.text.de?.text).toBe('Cancelled German');
});

it('batch completion follows its own drafts, discard, and closed loads', async () => {
  const s = await setup();
  const { done } = await import('../queue/batchQueue');
  const item = {
    key: `${s.batch.id}:123:de`,
    hash: 123,
    lang: 'de' as const,
    name: 'Perk',
    detail: { batchId: s.batch.id, path: '/t/123?lang=de' },
  };
  const queue = {
    version: 1 as const,
    id: 'batch',
    source: 'translations' as const,
    scope: 'shown' as const,
    origin: { path: '/translations', restore: {} },
    items: [item],
    skipped: [],
    current: item.key,
    finished: false,
    createdAt: 1,
    destination: { kind: 'batch' as const, batchId: s.batch.id, batchName: 'December patch' },
  };
  const context = {
    data: s.useDataStore.getState().data!,
    user: { id: 1, login: 'm', role: 'translator' as const, languages: ['de' as const] },
    decisions: {},
  };
  expect(done(queue, context, item)).toBe(false);
  s.runtime.edit(s.batch.id, s.future, s.future, 'de', 'German batch text', 'm');
  expect(done(queue, context, item)).toBe(true);
  s.runtime.discard(s.batch.id, 123);
  expect(done(queue, context, item)).toBe(false);
  s.upcomingStore().setState({ loads: {} });
  expect(done(queue, context, item)).toBe(false);
});
