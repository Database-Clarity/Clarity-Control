import { expect, it, vi } from 'vitest';
import {
  canAcknowledgeGlobal,
  globalReviewState,
  createGlobalsService,
  type GlobalCatalog,
  type GlobalResult,
} from '../src/services/globals';
import {
  createGlobalsFixture,
  fixtureHead,
  fixtureSources,
  globalFixtureSnapshot,
} from './globals-entries-fixture';

function pagedSeed() {
  const seed = structuredClone(globalFixtureSnapshot);
  for (let n = 2; n < 7; n++)
    seed.entries.push({
      ...structuredClone(seed.entries[1]),
      id: `g_extra000${n}`,
      name: `Extra${n}`,
    });
  for (let n = 30; n < 37; n++) {
    const row = structuredClone(seed.impacts.g_damage0001[0]);
    row.id = `review_${n}_en_live`;
    row.consumer.hash = n;
    row.review.consumer.hash = n;
    row.variant = n;
    seed.impacts.g_damage0001.push(row);
  }
  return seed;
}
const edit = (expectedHead = fixtureHead(1)) => ({
  expectedHead,
  mutation: {
    operation: 'edit' as const,
    id: 'g_damage0001',
    revision: 'r1',
    lang: 'en' as const,
    body: '25%',
  },
});

it('reads the whole catalogue once and fetches reviews only for the opened entry', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
  const catalog = vi.fn(fixture.catalog);
  const reviews = vi.spyOn(fixture.transport, 'reviews');
  const entry = vi.spyOn(fixture.transport, 'entry');
  const listed = vi.fn();
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    catalog,
    onCatalog: listed,
  });
  const first = service.readCatalog!();
  expect(service.readCatalog!()).toBe(first);
  const result = await first;
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value.entries).toHaveLength(7);
  expect(result.value.impacts).toEqual({});
  expect(result.value.sync.g_damage0001.status).toBe('current');
  expect(listed.mock.calls.map(([entries]) => entries.length)).toEqual([7]);
  await service.readCatalog!();
  expect(catalog).toHaveBeenCalledTimes(1);
  expect(entry).not.toHaveBeenCalled();
  expect(reviews).not.toHaveBeenCalled();
  const opening = service.readEntry('g_damage0001');
  expect(service.readEntry('g_damage0001')).toBe(opening);
  const opened = await opening;
  expect(opened.kind).toBe('ok');
  if (opened.kind !== 'ok') return;
  expect(entry.mock.calls).toEqual([['g_damage0001']]);
  // Every review page of the opened entry, from p0 (requested alongside the entry read).
  expect(reviews.mock.calls).toEqual([
    ['g_damage0001', 'p0'],
    ['g_damage0001', 'p1'],
    ['g_damage0001', 'p2'],
  ]);
  expect(opened.value.impacts.g_damage0001).toHaveLength(9);
});

it.each(['sync-pending', 'sync-failed'] as const)(
  'does not request unavailable reviews during %s and reads them once sync is current',
  async (status) => {
    const seed = structuredClone(globalFixtureSnapshot);
    for (const state of [...Object.values(seed.sync), ...Object.values(seed.destinationSync)]) {
      state.status = status;
      state.causeIds = ['waiting'];
    }
    const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, seed);
    const reviews = vi.spyOn(fixture.transport, 'reviews');
    const result = await fixture.service.read();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.sync.g_damage0001.status).toBe(status);
    expect(result.value.impacts.g_damage0001).toBeUndefined();
    const opened = await fixture.service.readEntry('g_damage0001');
    expect(opened.kind).toBe('ok');
    if (opened.kind !== 'ok') return;
    expect(opened.value.impacts.g_damage0001).toEqual([]);
    expect(reviews).not.toHaveBeenCalled();
    fixture.controls.syncOutcome = 'current';
    const current = await fixture.service.read();
    expect(current.kind).toBe('ok');
    if (current.kind !== 'ok') return;
    expect(current.value.sync.g_damage0001.status).toBe('current');
    expect(current.value.impacts.g_damage0001).toBeUndefined();
    await fixture.service.readEntry('g_damage0001');
    expect(reviews).toHaveBeenCalledWith('g_damage0001', 'p0');
  },
);

it('takes the head and sync state for writes from the opened entry, not an older catalogue', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const bundleHead = fixtureHead(7);
  // The bundle lags: older head, older body, and sync shown current at that head.
  const stale = async (): Promise<GlobalResult<GlobalCatalog>> => {
    const result = await fixture.catalog();
    if (result.kind !== 'ok') return result;
    result.value.head = bundleHead;
    result.value.entries[0].definitions.en!.body = 'stale';
    return result;
  };
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    catalog: stale,
  });
  const listed = await service.read();
  if (listed.kind !== 'ok') throw new Error('Missing catalogue');
  expect(listed.value.head).toBe(bundleHead);
  // A write against the bundle's head is refused before it reaches the Worker.
  const mutate = vi.spyOn(fixture.transport, 'mutate');
  expect((await service.mutate(edit())).kind).toBe('conflict');
  expect(mutate).not.toHaveBeenCalled();
  const opened = await service.readEntry('g_damage0001');
  if (opened.kind !== 'ok') throw new Error('Missing entry');
  expect(opened.value.head).toBe(fixtureHead(1));
  expect(opened.value.entries[0].definitions.en?.body).toBe(
    globalFixtureSnapshot.entries[0].definitions.en?.body,
  );
  expect(opened.value.impacts.g_damage0001).toHaveLength(2);
  expect((await service.mutate(edit())).kind).toBe('ok');
});

it('drops reviews read at an older head when an opened entry reports a newer head', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  await fixture.service.read();
  const first = await fixture.service.readEntry('g_damage0001');
  if (first.kind !== 'ok') throw new Error('Missing entry');
  expect(first.value.impacts.g_damage0001).toBeDefined();
  const original = fixture.transport.entry.bind(fixture.transport);
  vi.spyOn(fixture.transport, 'entry').mockImplementation(async (id) => {
    const result = await original(id);
    if (result.kind === 'ok') result.value.head = fixtureHead(99);
    return result;
  });
  const reviews = fixture.transport.reviews.bind(fixture.transport);
  vi.spyOn(fixture.transport, 'reviews').mockImplementation(async (id, cursor) => {
    const result = await reviews(id, cursor);
    if (result.kind === 'ok') result.value.head = fixtureHead(99);
    return result;
  });
  const second = await fixture.service.readEntry('g_title00001');
  if (second.kind !== 'ok') throw new Error(`Missing entry: ${second.message}`);
  expect(second.value.head).toBe(fixtureHead(99));
  expect(second.value.impacts.g_damage0001).toBeUndefined();
});

it('reports a save receipt so the tab can keep the saved entry until the bundle catches up', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const saved = vi.fn();
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    catalog: fixture.catalog,
    initialSnapshot: globalFixtureSnapshot,
    onEntrySaved: saved,
  });
  const result = await service.mutate(edit());
  if (result.kind !== 'ok') throw new Error('Save failed');
  expect(saved).toHaveBeenCalledTimes(1);
  const [entry, head] = saved.mock.calls[0];
  expect(entry.definitions.en.body).toBe('25%');
  expect(head).toBe(result.value.head);
});

it('merges a bounded changed-entry receipt without reading the catalogue or other reviews', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const catalog = vi.fn(fixture.catalog);
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    catalog,
    initialSnapshot: globalFixtureSnapshot,
  });
  const reviews = vi.spyOn(fixture.transport, 'reviews');
  const mutate = vi.spyOn(fixture.transport, 'mutate');
  const result = await service.mutate(edit());
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  const wire = await mutate.mock.results[0].value;
  expect(wire.kind).toBe('ok');
  if (wire.kind !== 'ok') return;
  expect(wire.value).not.toHaveProperty('entries');
  expect(wire.value).not.toHaveProperty('impacts');
  expect(wire.value).toHaveProperty('entry');
  expect(result.value.entries[0].definitions.en?.body).toBe('25%');
  expect(result.value.entries[1]).toEqual(globalFixtureSnapshot.entries[1]);
  expect(result.value.impacts).toEqual(globalFixtureSnapshot.impacts);
  expect(result.value.sync.g_title00001.status).toBe('sync-pending');
  expect(result.value.destinationSync.live.status).toBe('sync-pending');
  expect(
    canAcknowledgeGlobal(result.value, 'g_damage0001', result.value.impacts.g_damage0001[0]),
  ).toBe(false);
  expect(catalog).not.toHaveBeenCalled();
  expect(reviews).not.toHaveBeenCalled();
});

it('patches the audited row in every cached cause group from the small acknowledgement receipt', async () => {
  const seed = structuredClone(globalFixtureSnapshot);
  const row = seed.impacts.g_damage0001[0];
  row.causes.push({ globalId: 'g_title00001', beforeRevision: 'r0', afterRevision: 'r1' });
  seed.impacts.g_title00001 = [row];
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, seed);
  const mutate = vi.spyOn(fixture.transport, 'mutate');
  const result = await fixture.service.mutate({
    expectedHead: seed.head,
    mutation: {
      operation: 'acknowledge',
      id: 'g_damage0001',
      consumerId: row.id,
      contentDigest: row.review.contentDigest,
      dependencyDigest: row.review.dependencyDigest,
      impactDigest: row.impactDigest,
      decision: 'no-text-change',
    },
  });
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(globalReviewState(result.value.impacts.g_damage0001[0])).toBe('acknowledged');
  expect(globalReviewState(result.value.impacts.g_title00001[0])).toBe('acknowledged');
  const wire = await mutate.mock.results[0].value;
  if (wire.kind !== 'ok') throw new Error('Missing audit receipt');
  expect(wire.value).toHaveProperty('consumerId');
  expect(wire.value).not.toHaveProperty('entry');
  expect(wire.value).not.toHaveProperty('impacts');
});

it('does not publish partial review pages when a head or source pin changes', async () => {
  for (const drift of ['head', 'sources'] as const) {
    const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
    await fixture.service.read();
    const original = fixture.transport.reviews.bind(fixture.transport);
    vi.spyOn(fixture.transport, 'reviews').mockImplementation(async (id, cursor) => {
      const page = await original(id, cursor);
      if (page.kind === 'ok' && cursor === 'p1') {
        if (drift === 'head') page.value.head = fixtureHead(999);
        else page.value.sources = { ...fixtureSources, aliases: '9'.repeat(40) };
      }
      return page;
    });
    expect((await fixture.service.readEntry('g_damage0001')).kind).toBe('conflict');
    expect((await fixture.service.mutate(edit())).kind).toBe('ok');
  }
});

it('rejects a catalogue with duplicate identities without replacing a known snapshot', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    initialSnapshot: globalFixtureSnapshot,
    catalog: async () => {
      const result = await fixture.catalog();
      if (result.kind === 'ok') result.value.entries.push(structuredClone(result.value.entries[0]));
      return result;
    },
  });
  expect((await service.read()).kind).toBe('invalid');
  expect((await service.mutate(edit())).kind).toBe('ok');
});

it('passes a catalogue refusal through and keeps the last complete snapshot', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    initialSnapshot: globalFixtureSnapshot,
    catalog: async () => ({
      kind: 'retry',
      message: 'Sync pending: global metadata is incomplete',
    }),
  });
  expect(await service.read()).toEqual({
    kind: 'retry',
    message: 'Sync pending: global metadata is incomplete',
  });
  const kept = await service.readCatalog!();
  if (kept.kind !== 'ok') throw new Error('Lost the last complete catalogue');
  expect(kept.value.entries).toHaveLength(globalFixtureSnapshot.entries.length);
});

it('ignores a late refresh after a newer mutation delta is merged', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const oldCatalog = await fixture.catalog();
  let release!: (value: typeof oldCatalog) => void;
  const service = createGlobalsService(fixture.transport, {
    destinations: ['live', 'saved'],
    initialSnapshot: globalFixtureSnapshot,
    catalog: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const staleRead = service.read();
  const saved = await service.mutate(edit());
  expect(saved.kind).toBe('ok');
  release(oldCatalog);
  expect((await staleRead).kind).toBe('conflict');
  const current = await service.readEntry('g_damage0001');
  if (current.kind !== 'ok') throw new Error('Lost the newer cache');
  expect(current.value.entries[0].definitions.en?.body).toBe('25%');
});

it('propagates transport refusals and refuses foreign entry receipts', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const mutate = vi.spyOn(fixture.transport, 'mutate');
  mutate.mockResolvedValueOnce({ kind: 'forbidden', message: 'Role changed.' });
  expect(await fixture.service.mutate(edit())).toEqual({
    kind: 'forbidden',
    message: 'Role changed.',
  });
  const entry = await fixture.transport.entry('g_title00001');
  if (entry.kind !== 'ok') throw new Error('Missing fixture entry');
  mutate.mockResolvedValueOnce(entry);
  expect((await fixture.service.mutate(edit())).kind).toBe('invalid');
});
