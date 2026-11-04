import { afterEach, expect, it, vi } from 'vitest';
import { GuidancePersistence } from './guidancePersistence';
import type { GuidanceDocument } from './guidanceSchema';
import type { GuidanceReference } from './guidanceSchema';

const categories = [
  {
    id: 'catalog:weapon-trait',
    name: 'Weapon traits',
    rule: 'categoryId = weapon-trait',
    count: 1,
    hashes: [10],
    active: true,
  },
];
function fixture() {
  let document: GuidanceDocument | null = null;
  let revision: string | null = null;
  let writes = 0;
  const cache = new Map<string, string>();
  const storage = {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      if (payload.revision !== revision) return new Response('changed', { status: 409 });
      document = payload.document;
      revision = String(++writes);
    }
    return Response.json({ document, revision });
  });
  const create = () =>
    new GuidancePersistence('scope', 'http://localhost/__review-guidance', storage, request);
  return { create, request, cache, storage, document: () => document, writes: () => writes };
}
afterEach(() => vi.useRealTimers());
it('does not rewrite unchanged production guidance on flush, route teardown, or remount', async () => {
  const data = fixture();
  const writes = vi.spyOn(data.storage, 'setItem');
  const create = () => new GuidancePersistence('scope', '', data.storage, data.request, false);
  const first = create();
  await first.start();
  first.synchronize(categories, 'baseline');
  writes.mockClear();
  const reads = vi.spyOn(data.storage, 'getItem');
  await first.flush();
  first.dispose();
  expect(writes).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  const second = create();
  await second.start();
  second.synchronize(categories, 'baseline');
  expect(writes).not.toHaveBeenCalled();
  second.comment(categories[0].id, 'Authored guidance remains immediately backed up');
  expect(writes).toHaveBeenCalledTimes(1);
  expect([...data.cache.values()][0]).toContain('Authored guidance remains immediately backed up');
  second.dispose();
  expect(writes).toHaveBeenCalledTimes(1);
});

it('keeps loaded membership frozen while applying current owner edits', async () => {
  const data = fixture();
  const writer = data.create();
  await writer.start();
  writer.synchronize(categories, 'baseline');
  await writer.flush();
  const reader = data.create();
  await reader.start();
  const loaded = reader.getSnapshot().proposalInput;
  reader.synchronize([{ ...categories[0], count: 2, hashes: [10, 11] }], 'new-baseline');
  reader.comment(categories[0].id, 'New comment');
  expect(reader.getSnapshot().proposalInput?.categories[categories[0].id].comment).toBe(
    'New comment',
  );
  expect(reader.getSnapshot().proposalInput?.categories[categories[0].id].hashes).toEqual([10]);
  expect(loaded?.categories[categories[0].id].hashes).toEqual([10]);
  expect(loaded?.baseline).toBe('baseline');
  await reader.flush();
  await reader.reloadDisk();
  expect(reader.getSnapshot().proposalInput?.categories[categories[0].id].hashes).toEqual([10, 11]);
  reader.dispose();
  writer.dispose();
});
it('retains typed comments and references during conflicts without overwriting newer disk guidance', async () => {
  const data = fixture();
  const first = data.create();
  await first.start();
  first.synchronize(categories, 'baseline');
  await first.flush();
  const second = data.create();
  await second.start();
  first.comment(categories[0].id, 'Latest disk instruction');
  await first.flush();
  second.comment(categories[0].id, 'Local note');
  await second.flush();
  expect(second.getSnapshot().conflict).toBe(true);
  second.comment(categories[0].id, 'I can still type after conflict');
  const reference: GuidanceReference = {
    categoryId: categories[0].id,
    hash: 10,
    name: 'Example',
    evidence: 'evidence',
    baseline: 'baseline',
    timestamp: '2026-11-01T00:00:00Z',
    decision: 'no-equivalent',
    note: 'Local reference',
  };
  second.reference(categories[0].id, reference);
  await second.flush();
  expect(second.getSnapshot().document.categories[categories[0].id]).toMatchObject({
    comment: 'I can still type after conflict',
    references: { 10: reference },
  });
  expect(data.document()?.categories[categories[0].id].comment).toBe('Latest disk instruction');
  expect([...data.cache.values()][0]).toContain('Local reference');
  await second.reloadDisk();
  first.dispose();
  second.dispose();
});
it('autosaves reference notes and resolutions, preserves legacy comments and retains references through membership changes', async () => {
  vi.useFakeTimers();
  const data = fixture();
  const owner = data.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Existing owner guidance');
  const reference: GuidanceReference = {
    categoryId: categories[0].id,
    hash: 10,
    name: 'Example',
    evidence: 'evidence',
    baseline: 'baseline',
    timestamp: '2026-11-01T00:00:00Z',
    decision: 'no-equivalent',
    note: 'No source',
  };
  owner.reference(categories[0].id, reference);
  await vi.advanceTimersByTimeAsync(401);
  expect(data.document()?.categories[categories[0].id]).toMatchObject({
    comment: 'Existing owner guidance',
    references: { 10: reference },
  });
  const phone = data.create();
  await phone.start();
  expect(phone.getSnapshot().document).toEqual(owner.getSnapshot().document);
  owner.synchronize([], 'new evidence');
  expect(owner.getSnapshot().document.categories[categories[0].id]).toMatchObject({
    active: false,
    references: { 10: reference },
    comment: 'Existing owner guidance',
  });
  await owner.flush();
  owner.dispose();
  phone.dispose();
});
it('pauses editing/retries during a delayed reload and preserves text and backup changed after it starts', async () => {
  const data = fixture();
  const owner = data.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Previously saved');
  await owner.flush();
  const original = data.request.getMockImplementation()!;
  let release = () => {};
  data.request.mockImplementationOnce(async (url, init) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(url, init);
  });
  const reloading = owner.reloadDisk();
  expect(owner.getSnapshot().reloading).toBe(true);
  owner.comment(categories[0].id, 'New owner instruction typed while reloading');
  owner.synchronize([], 'changed membership while reloading');
  const reads = data.request.mock.calls.length;
  await owner.reloadDisk();
  await owner.flush();
  expect(data.request).toHaveBeenCalledTimes(reads);
  release();
  await reloading;
  expect(owner.getSnapshot()).toMatchObject({ reloading: false, diskSaved: false });
  expect(owner.getSnapshot().document.categories[categories[0].id]).toMatchObject({
    comment: 'New owner instruction typed while reloading',
    active: true,
  });
  expect(owner.getSnapshot().error).toContain('browser comments retained');
  expect(JSON.parse([...data.cache.values()][0])).toMatchObject({
    pending: true,
    document: {
      categories: {
        [categories[0].id]: {
          comment: 'New owner instruction typed while reloading',
        },
      },
    },
  });
  expect(data.document()?.categories[categories[0].id].comment).toBe('Previously saved');
  await owner.flush();
  expect(owner.getSnapshot().diskSaved).toBe(true);
  expect(data.document()?.categories[categories[0].id].comment).toBe(
    'New owner instruction typed while reloading',
  );
  owner.dispose();
});
it('does not start a reload over an outstanding save, then reloads its exact acknowledgement', async () => {
  const data = fixture();
  const owner = data.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Saved after delay');
  const original = data.request.getMockImplementation()!;
  let release = () => {};
  data.request.mockImplementationOnce(async (url, init) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(url, init);
  });
  const saving = owner.flush();
  const calls = data.request.mock.calls.length;
  await owner.reloadDisk();
  expect(data.request).toHaveBeenCalledTimes(calls);
  expect(owner.getSnapshot()).toMatchObject({ saving: true, reloading: false });
  release();
  await saving;
  await owner.reloadDisk();
  expect(owner.getSnapshot()).toMatchObject({ saving: false, reloading: false, diskSaved: true });
  expect(owner.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'Saved after delay',
  );
  owner.dispose();
});
it('reenables editing after a failed reload without discarding the pending backup', async () => {
  const data = fixture();
  const owner = data.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Keep this unsaved text');
  data.request.mockRejectedValueOnce(new Error('offline'));
  await owner.reloadDisk();
  expect(owner.getSnapshot()).toMatchObject({ reloading: false, diskSaved: false });
  expect(owner.getSnapshot().error).toContain('browser comments retained');
  expect([...data.cache.values()][0]).toContain('Keep this unsaved text');
  await owner.flush();
  owner.dispose();
});
it('autosaves as the owner types, persists definitions and reloads comments without exporting', async () => {
  vi.useFakeTimers();
  const fixtureData = fixture();
  const owner = fixtureData.create();
  await Promise.all([owner.start(), owner.start()]);
  expect(fixtureData.request).toHaveBeenCalledTimes(1);
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Only link mechanics, not lore.');
  expect([...fixtureData.cache.values()][0]).toContain('Only link mechanics');
  expect(fixtureData.writes()).toBe(0);
  await vi.advanceTimersByTimeAsync(401);
  expect(fixtureData.document()?.categories[categories[0].id]).toEqual({
    ...categories[0],
    comment: 'Only link mechanics, not lore.',
  });
  expect(owner.getSnapshot().diskSaved).toBe(true);
  const phone = fixtureData.create();
  await phone.start();
  expect(phone.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'Only link mechanics, not lore.',
  );
  owner.dispose();
  phone.dispose();
});
it('keeps comments attached to stable ids as counts change and retains inactive category guidance', async () => {
  const fixtureData = fixture();
  const owner = fixtureData.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Preserve this instruction.');
  owner.synchronize([{ ...categories[0], count: 2, hashes: [10, 20] }], 'new baseline');
  expect(owner.getSnapshot().document.categories[categories[0].id]).toMatchObject({
    comment: 'Preserve this instruction.',
    count: 2,
    hashes: [10, 20],
  });
  owner.synchronize([], 'latest baseline');
  expect(owner.getSnapshot().document.categories[categories[0].id]).toMatchObject({
    active: false,
    comment: 'Preserve this instruction.',
  });
  await owner.flush();
  owner.dispose();
});
it('never overwrites concurrent phone/tab guidance; retains unsaved backup and allows explicit disk reload', async () => {
  const fixtureData = fixture();
  const first = fixtureData.create();
  await first.start();
  first.synchronize(categories, 'baseline');
  await first.flush();
  const second = fixtureData.create();
  await second.start();
  first.comment(categories[0].id, 'First tab guidance');
  await first.flush();
  second.comment(categories[0].id, 'Conflicting phone guidance');
  await second.flush();
  expect(second.getSnapshot()).toMatchObject({ conflict: true, diskSaved: false });
  expect(fixtureData.document()?.categories[categories[0].id].comment).toBe('First tab guidance');
  expect([...fixtureData.cache.values()][0]).toContain('Conflicting phone guidance');
  await second.reloadDisk();
  expect(second.getSnapshot()).toMatchObject({ conflict: false, diskSaved: true });
  expect(second.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'First tab guidance',
  );
  first.dispose();
  second.dispose();
});
it('recovers pending browser comments after a disk outage and makes local-only failure explicit', async () => {
  const fixtureData = fixture();
  fixtureData.request.mockRejectedValueOnce(new Error('offline'));
  const owner = fixtureData.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  owner.comment(categories[0].id, 'Recovered guidance');
  fixtureData.request.mockRejectedValueOnce(new Error('offline'));
  await owner.flush();
  expect(owner.getSnapshot().error).toContain('Not saved to disk');
  const resumed = fixtureData.create();
  await resumed.start();
  expect(resumed.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'Recovered guidance',
  );
  await resumed.flush();
  expect(fixtureData.document()?.categories[categories[0].id].comment).toBe('Recovered guidance');
  owner.dispose();
  resumed.dispose();
});
it('serializes saves without dropping text typed during an outstanding write', async () => {
  const fixtureData = fixture();
  const owner = fixtureData.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  const original = fixtureData.request.getMockImplementation()!;
  let release = () => {};
  fixtureData.request.mockImplementationOnce(async (url, init) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(url, init);
  });
  owner.comment(categories[0].id, 'First');
  const saving = owner.flush();
  owner.comment(categories[0].id, 'Latest typing');
  await owner.flush();
  release();
  await saving;
  expect(owner.getSnapshot().diskSaved).toBe(false);
  await owner.flush();
  expect(fixtureData.document()?.categories[categories[0].id].comment).toBe('Latest typing');
  owner.dispose();
});
it('reports corrupt backups and unavailable storage and refuses a different disk dataset', async () => {
  const fixtureData = fixture();
  const owner = new GuidancePersistence(
    'scope',
    '/guidance',
    {
      getItem: () => 'broken json',
      setItem: () => {
        throw new Error('quota');
      },
    },
    fixtureData.request,
  );
  await owner.start();
  owner.synchronize(categories, 'baseline');
  expect(owner.getSnapshot().localError).toContain('quota');
  await owner.flush();
  expect(owner.getSnapshot().diskSaved).toBe(true);
  expect(owner.getSnapshot().localError).toContain('quota');
  const other = new GuidancePersistence(
    'other',
    '/guidance',
    fixtureData.storage,
    fixtureData.request,
  );
  await other.start();
  expect(other.getSnapshot().error).toContain('another dataset');
  owner.dispose();
  other.dispose();
});
it('does not replay a pending browser backup over newer disk guidance after reopening', async () => {
  const data = fixture();
  const first = data.create();
  await first.start();
  first.synchronize(categories, 'baseline');
  await first.flush();
  const stale = data.create();
  await stale.start();
  first.comment(categories[0].id, 'New disk guidance');
  await first.flush();
  stale.comment(categories[0].id, 'Unsaved stale backup');
  const reopened = data.create();
  await reopened.start();
  expect(reopened.getSnapshot()).toMatchObject({ conflict: true, diskSaved: false });
  expect(reopened.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'Unsaved stale backup',
  );
  await reopened.flush();
  expect(data.document()?.categories[categories[0].id].comment).toBe('New disk guidance');
  await stale.reloadDisk();
  first.dispose();
  stale.dispose();
  reopened.dispose();
});
it('never reports disk success for an acknowledgement of different guidance', async () => {
  const data = fixture();
  const owner = data.create();
  await owner.start();
  owner.synchronize(categories, 'baseline');
  data.request.mockResolvedValueOnce(
    Response.json({
      revision: 'bad-ack',
      document: { version: 1, scope: 'scope', baseline: 'wrong data', categories: {} },
    }),
  );
  await owner.flush();
  expect(owner.getSnapshot()).toMatchObject({ diskSaved: false });
  expect(owner.getSnapshot().error).toContain('invalid acknowledgement');
  await owner.flush();
  owner.dispose();
});

it('imports validated same-scope backups, freezes planning membership and rejects scope/conflict', async () => {
  const data = fixture();
  const writer = data.create();
  await writer.start();
  writer.synchronize(categories, 'old');
  const imported = structuredClone(writer.getSnapshot().document);
  imported.baseline = 'renewed';
  const revision = writer.getSnapshot().planningRevision;
  writer.importBackup(imported);
  expect(writer.getSnapshot().proposalInput).toEqual(imported);
  expect(writer.getSnapshot().planningRevision).toBeGreaterThan(revision);
  expect(() => writer.importBackup({ ...imported, scope: 'other' })).toThrow(/dataset/);
  expect(() => writer.importBackup({ version: 999 })).toThrow();
  writer.synchronize([{ ...categories[0], count: 2, hashes: [10, 11] }], 'current');
  expect(writer.getSnapshot().proposalInput?.categories[categories[0].id].hashes).toEqual([10]);
  await writer.flush();
  writer.dispose();
});

it('keeps hosted guidance in the browser across reloads without any dev endpoint access', async () => {
  const f = fixture();
  const hosted = () =>
    new GuidancePersistence('scope', '/__review-guidance', f.storage, f.request, false);
  const first = hosted();
  await first.start();
  first.synchronize(categories, 'baseline');
  first.comment(categories[0].id, 'Keep this hosted note');
  first.reference(categories[0].id, {
    categoryId: categories[0].id,
    hash: 10,
    name: 'Example',
    evidence: 'evidence',
    baseline: 'baseline',
    timestamp: '2026-11-01T00:00:00Z',
    decision: 'skipped',
    note: 'Revisit later',
  });
  await first.flush();
  expect(first.getSnapshot()).toMatchObject({
    browserSaved: true,
    diskAvailable: false,
    diskSaved: false,
    error: null,
  });
  first.dispose();
  const second = hosted();
  await second.start();
  expect(second.getSnapshot().document.categories[categories[0].id].comment).toBe(
    'Keep this hosted note',
  );
  expect(second.getSnapshot().document.categories[categories[0].id].references?.[10].decision).toBe(
    'skipped',
  );
  await second.reloadDisk();
  second.dispose();
  expect(f.request).not.toHaveBeenCalled();
});
it('does not claim hosted browser persistence after storage fails', async () => {
  const request = vi.fn<typeof fetch>();
  const persistence = new GuidancePersistence(
    'scope',
    '/__review-guidance',
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('<html>quota</html>' + 'x'.repeat(1000));
      },
    },
    request,
    false,
  );
  await persistence.start();
  expect(persistence.getSnapshot().browserSaved).toBe(false);
  expect(persistence.getSnapshot().localError).toContain('Browser backup failed');
  expect(persistence.getSnapshot().localError).not.toContain('<html>');
  expect(persistence.getSnapshot().localError!.length).toBeLessThan(350);
  persistence.dispose();
  expect(request).not.toHaveBeenCalled();
});
