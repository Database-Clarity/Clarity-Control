import { expect, it, vi } from 'vitest';
import { createGlobalsService, type GlobalCatalog, type GlobalResult } from '../src/services/globals';
import { createGlobalsFixture, fixtureHead, globalFixtureSnapshot } from './globals-entries-fixture';

function pagedSeed() {
  const seed = structuredClone(globalFixtureSnapshot);
  for (let n = 2; n < 7; n++)
    seed.entries.push({
      ...structuredClone(seed.entries[1]),
      id: `g_extra000${n}`,
      name: `Extra${n}`,
    });
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

it('shares catalogue and opened-entry reads', async () => {
  const fixture = createGlobalsFixture(pagedSeed());
  const catalog = vi.fn(fixture.catalog);
  const entry = vi.spyOn(fixture.transport, 'entry');
  const service = createGlobalsService(fixture.transport, { catalog });
  const first = service.readCatalog!();
  expect(service.readCatalog!()).toBe(first);
  const listed = await first;
  expect(listed.kind === 'ok' && listed.value.entries).toHaveLength(7);
  expect(entry).not.toHaveBeenCalled();
  const opened = service.readEntry('g_damage0001');
  expect(service.readEntry('g_damage0001')).toBe(opened);
  expect((await opened).kind).toBe('ok');
  expect(entry.mock.calls).toEqual([['g_damage0001']]);
  expect(catalog).toHaveBeenCalledTimes(1);
});

it('takes the head for writes from the opened entry, not an older catalogue', async () => {
  const fixture = createGlobalsFixture();
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
  expect((await service.mutate(edit())).kind).toBe('ok');
});

it('reports a save receipt so the tab can keep the saved entry until the bundle catches up', async () => {
  const fixture = createGlobalsFixture();
  const saved = vi.fn();
  const service = createGlobalsService(fixture.transport, {
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

it('merges a bounded changed-entry receipt without reading the catalogue', async () => {
  const fixture = createGlobalsFixture();
  const catalog = vi.fn(fixture.catalog);
  const service = createGlobalsService(fixture.transport, {
    catalog,
    initialSnapshot: globalFixtureSnapshot,
  });
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
  expect(catalog).not.toHaveBeenCalled();
});

it('rejects a catalogue with duplicate identities without replacing a known snapshot', async () => {
  const fixture = createGlobalsFixture(pagedSeed());
  const service = createGlobalsService(fixture.transport, {
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
  const fixture = createGlobalsFixture();
  const service = createGlobalsService(fixture.transport, {
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
  const fixture = createGlobalsFixture();
  const oldCatalog = await fixture.catalog();
  let release!: (value: typeof oldCatalog) => void;
  const service = createGlobalsService(fixture.transport, {
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
  const fixture = createGlobalsFixture();
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
