import { expect, it, vi } from 'vitest';
import { canAcknowledgeGlobal, globalReviewState } from '../src/services/globals';
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

it('refreshes three-record catalog and review pages and supports the single-entry endpoint', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
  const list = vi.spyOn(fixture.transport, 'list');
  const reviews = vi.spyOn(fixture.transport, 'reviews');
  const entry = vi.spyOn(fixture.transport, 'entry');
  const result = await fixture.service.read();
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value.entries).toHaveLength(7);
  expect(result.value.impacts.g_damage0001).toHaveLength(9);
  expect(list.mock.calls.map(([cursor]) => cursor)).toEqual(['p0', 'p1', 'p2']);
  expect(
    reviews.mock.calls.filter(([id]) => id === 'g_damage0001').map(([, cursor]) => cursor),
  ).toEqual(['p0', 'p1', 'p2']);
  const one = await fixture.service.readEntry('g_title00001');
  expect(one.kind).toBe('ok');
  expect(entry).toHaveBeenCalledWith('g_title00001');
});

it('merges a bounded changed-entry receipt without fetching the catalogue or other reviews', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const list = vi.spyOn(fixture.transport, 'list');
  const reviews = vi.spyOn(fixture.transport, 'reviews');
  const mutate = vi.spyOn(fixture.transport, 'mutate');
  const result = await fixture.service.mutate(edit());
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
  expect(list).not.toHaveBeenCalled();
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

it('does not publish partial pages when a head or source pin changes', async () => {
  for (const drift of ['head', 'sources'] as const) {
    const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
    const original = fixture.transport.reviews.bind(fixture.transport);
    if (drift === 'sources') {
      const list = fixture.transport.list.bind(fixture.transport);
      vi.spyOn(fixture.transport, 'list').mockImplementation(async (cursor) => {
        const page = await list(cursor);
        if (page.kind === 'ok') page.value.sources = { ...fixtureSources };
        return page;
      });
    }
    vi.spyOn(fixture.transport, 'reviews').mockImplementation(async (id, cursor) => {
      const page = await original(id, cursor);
      if (page.kind === 'ok' && drift === 'sources') page.value.sources = { ...fixtureSources };
      if (page.kind === 'ok' && cursor === 'p1') {
        if (drift === 'head') page.value.head = fixtureHead(999);
        else page.value.sources = { ...page.value.sources!, aliases: '9'.repeat(40) };
      }
      return page;
    });
    expect((await fixture.service.read()).kind).toBe('conflict');
    expect((await fixture.service.mutate(edit())).kind).toBe('ok');
  }
});

it('rejects oversized or looping pages without replacing a known snapshot', async () => {
  for (const malformed of ['size', 'cursor'] as const) {
    const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, pagedSeed());
    const original = fixture.transport.list.bind(fixture.transport);
    vi.spyOn(fixture.transport, 'list').mockImplementation(async (cursor) => {
      const page = await original(cursor);
      if (page.kind === 'ok') {
        if (malformed === 'cursor') page.value.nextCursor = 'p0';
        else page.value.entries.push(structuredClone(page.value.entries[0]));
      }
      return page;
    });
    expect((await fixture.service.read()).kind).toBe('invalid');
    expect((await fixture.service.mutate(edit())).kind).toBe('ok');
  }
});

it('ignores a late refresh after a newer mutation delta is merged', async () => {
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] });
  const oldPage = await fixture.transport.list('p0');
  let release!: (value: typeof oldPage) => void;
  vi.spyOn(fixture.transport, 'list').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const staleRead = fixture.service.read();
  const saved = await fixture.service.mutate(edit());
  expect(saved.kind).toBe('ok');
  release(oldPage);
  expect((await staleRead).kind).toBe('conflict');
  const current = await fixture.service.readEntry('g_damage0001');
  if (current.kind !== 'ok') throw new Error('Lost the newer cache');
  expect(current.value.entries[0].definitions.en?.body).toBe('25%');
});

it('retains prior rows without fetching unavailable review pages while repository sync is pending', async () => {
  const seed = structuredClone(globalFixtureSnapshot);
  seed.sync.g_damage0001 = { status: 'sync-pending', causeIds: ['cause_1'] };
  seed.destinationSync.live = { status: 'sync-pending', causeIds: ['cause_1'] };
  const fixture = createGlobalsFixture({ role: 'editor', languages: [] }, seed);
  const reviews = vi.spyOn(fixture.transport, 'reviews');
  const result = await fixture.service.read();
  if (result.kind !== 'ok') throw new Error('Pending metadata should be readable');
  expect(reviews).not.toHaveBeenCalled();
  expect(result.value.impacts).toEqual(seed.impacts);
  expect(result.value.sync.g_title00001.status).toBe('sync-pending');
  expect(result.value.destinationSync.saved.status).toBe('sync-pending');
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
