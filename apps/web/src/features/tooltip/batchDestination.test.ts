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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
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
  const { useDataStore } = await import('../../stores/data');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDraftStore } = await import('../../stores/drafts');
  const { useBatchDraftStore, batchDraftKey } =
    await import('../../services/scheduled/batchDrafts');
  const loader = await import('./UpcomingSwitch.load');
  const { upcomingStore } = await import('./UpcomingSwitch.store');
  const runtime = await import('./batchDestination.live');
  const data = editorData();
  data.bundle.tooltips[123] = current;
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
    current,
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
