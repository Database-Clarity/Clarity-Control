import { afterEach, expect, it, vi } from 'vitest';
import { GuidancePersistence } from './guidancePersistence';
import type { GuidanceDocument } from './guidanceSchema';

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
