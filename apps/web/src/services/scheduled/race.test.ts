/**
 * Advisory-index races (code review round 1, sched-actions-c-code.md findings 1 and 2; the
 * reproductions are the reviewer's; round 2 adds Upcoming): a read at a head older than an overlaid revision is
 * never certified fresh, and a late answer from an older head never brings back an older state.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBatchFixture } from './fixtureWorker.testSupport';

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

it('does not mark an older pinned detail fresh at an overlaid revision, and reads it again', async () => {
  const fixture = createBatchFixture({
    current: {},
    user: { id: 1, login: 'm', role: 'maintainer' },
  });
  vi.stubGlobal('fetch', fixture.fetch);
  const api = await import('./api');
  const { batch } = await api.createBatch('Race');
  const oldListing = await (await fixture.fetch('https://worker.example/batches')).json();
  const queued = await api.queueBatchSave(batch.id, batch.revision, [], 'Queue');
  let lag = true;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (lag && new URL(request.url).pathname === '/batches')
      return Promise.resolve(Response.json(oldListing));
    return fixture.fetch(request);
  });
  const store = await import('../../features/review/batches/store');
  await store.refreshBatches();
  await vi.waitFor(() => expect(store.useBatches.getState().loads[batch.id]?.state).toBe('ready'));
  // Read at the old head: the load says what it read (r1), so the r2 entry is not fresh.
  const stale = store.useBatches.getState();
  expect(stale.entries?.[0].revision).toBe(queued.batch.revision);
  expect(stale.loads[batch.id]?.revision).toBeLessThan(queued.batch.revision);
  lag = false;
  await store.refreshBatches();
  await vi.waitFor(() => {
    const load = store.useBatches.getState().loads[batch.id];
    expect(load?.state).toBe('ready');
    expect(load?.revision).toBe(queued.batch.revision);
  });
  const load = store.useBatches.getState().loads[batch.id];
  if (load?.state === 'ready') {
    expect(load.detail.batch.revision).toBe(load.revision);
    expect(load.detail.batch.status).toBe('preparing');
  }
  store.resetBatches();
});

it('keeps the highest revision after the index catches up and older answers arrive late', async () => {
  const fixture = createBatchFixture({
    current: {},
    user: { id: 1, login: 'm', role: 'maintainer' },
  });
  vi.stubGlobal('fetch', fixture.fetch);
  const api = await import('./api');
  const { batch } = await api.createBatch('Race');
  const oldListing = await (await fixture.fetch('https://worker.example/batches')).json();
  await api.endBatchSchedule(batch.id, batch.revision, 'cancel');
  const newListing = await api.listBatches();
  await api.readBatch(oldListing.head, batch.id); // an old commit-pinned answer arrives later
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(oldListing)));
  const lateListing = await api.listBatches();
  expect(lateListing.index.batches[0].revision).toBe(newListing.index.batches[0].revision);
  expect(lateListing.index.batches[0].status).toBe('cancelled');
});

it('Upcoming never certifies old-head members at an overlaid revision, and reads them again', async () => {
  const { editorData, tooltip } = await import('../save/fixtures.testSupport');
  const old = { ...tooltip, text: { en: { ...tooltip.text.en!, text: 'Before save' } } };
  const next = { ...old, text: { en: { ...old.text.en, text: 'After save' } } };
  const fixture = createBatchFixture({
    current: { 123: old },
    user: { id: 1, login: 'm', role: 'maintainer' },
  });
  vi.stubGlobal('fetch', fixture.fetch);
  const api = await import('./api');
  const { batch } = await api.createBatch('Upcoming race');
  const saved = await api.saveToBatch(
    batch.id,
    batch.revision,
    'draft',
    [{ hash: 123, base: old, next: old }],
    'Initial',
  );
  const oldListing = await (await fixture.fetch('https://worker.example/batches')).json();
  const queued = await api.queueBatchSave(
    batch.id,
    saved.batch!.revision,
    [{ hash: 123, base: old, next }],
    'Queued',
  );
  fixture.completeRequest(queued.requestId);
  const status = await api.readBatchStatus(batch.id, undefined, queued.requestId);
  const { useDataStore } = await import('../../stores/data');
  const data = editorData();
  data.bundle.tooltips[123] = old;
  useDataStore.setState({ data, status: 'ready' });
  let lag = true;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (lag && new URL(request.url).pathname === '/batches')
      return Promise.resolve(Response.json(oldListing));
    return fixture.fetch(request);
  });
  const loader = await import('../../features/tooltip/UpcomingSwitch.load');
  const { upcomingStore } = await import('../../features/tooltip/UpcomingSwitch.store');
  await loader.refreshBatches();
  loader.ensureBatch(batch.id);
  await vi.waitFor(() => expect(upcomingStore().getState().loads[batch.id]?.state).toBe('ready'));
  const stale = upcomingStore().getState().loads[batch.id];
  // Read at the old head: the load keeps the older revision it read (code review round 2).
  expect(stale?.revision).toBeLessThan(status.batch.revision);
  lag = false;
  await loader.refreshBatches();
  loader.ensureBatch(batch.id);
  await vi.waitFor(() => {
    const load = upcomingStore().getState().loads[batch.id];
    expect(load?.revision).toBe(status.batch.revision);
  });
  const load = upcomingStore().getState().loads[batch.id];
  expect(load?.state === 'ready' && load.upcoming.members[123]?.proposed.text.en?.text).toBe(
    'After save',
  );
  loader.resetUpcoming();
});
