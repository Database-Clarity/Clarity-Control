import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createBatchFixture, type BatchFixture } from './fixtureWorker.testSupport';

const tooltip = (hash: number, en: string, extra: Partial<Tooltip['text']> = {}): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' }, ...extra },
});
const hashes = (count: number, from = 100) => Array.from({ length: count }, (_, i) => from + i);

async function load() {
  vi.resetModules();
  return import('./api');
}

describe('scheduled batches client: writes and detail reads', () => {
  let fixture: BatchFixture;
  let posts: { path: string; body: { revision?: number; changes?: unknown[] } }[];
  const setup = (caps?: Parameters<typeof createBatchFixture>[0]['caps']) => {
    fixture = createBatchFixture({
      current: Object.fromEntries(hashes(30).map((hash) => [hash, tooltip(hash, `Old ${hash}`)])),
      user: { id: 1, login: 'm', role: 'maintainer' },
      caps,
    });
    posts = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST')
        posts.push({
          path: new URL(request.url).pathname,
          body: JSON.parse(await request.clone().text()) as never,
        });
      return fixture.fetch(request);
    });
  };
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    for (const name of ['localStorage', 'sessionStorage'])
      vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
    setup();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const change = (hash: number, en: string) => ({
    hash,
    base: tooltip(hash, `Old ${hash}`),
    next: tooltip(hash, en),
  });

  it('chunks a 30-change save into a draft batch at 15 per request, chaining the revision', async () => {
    setup({ members: 30 });
    const api = await load();
    const { batch } = await api.createBatch('Big');
    const changes = hashes(30).map((hash) => change(hash, `New ${hash}`));
    const result = await api.saveToBatch(batch.id, batch.revision, 'draft', changes, 'Stage');
    const saves = posts.filter(({ path }) => path.endsWith('/save'));
    expect(saves.map(({ body }) => [body.revision, body.changes?.length])).toEqual([
      [1, 15],
      [2, 15],
    ]);
    expect(result.accepted).toEqual(hashes(30));
    expect(result.commits).toHaveLength(2);
    expect(result.batch?.revision).toBe(3);
    expect(fixture.members.get(batch.id)?.size).toBe(30);
  });

  it('chunks translation saves into a scheduled batch at 10 per request', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Scheduled');
    const twelve = hashes(12);
    await api.saveToBatch(
      batch.id,
      batch.revision,
      'draft',
      twelve.map((hash) => change(hash, `New ${hash}`)),
      'm',
    );
    const scheduled = await api.scheduleBatch(
      batch.id,
      2,
      '2026-12-03T16:00:00.000Z',
      'Europe/Berlin',
    );
    expect(scheduled.batch.status).toBe('scheduled');
    posts.length = 0;
    const german = { de: { text: 'Neu', updatedAt: '2026-11-02T00:00:00.000Z', updatedBy: 'm' } };
    const translations = twelve.map((hash) => ({
      hash,
      base: tooltip(hash, `New ${hash}`),
      next: tooltip(hash, `New ${hash}`, german),
    }));
    const result = await api.saveToBatch(batch.id, 3, 'scheduled', translations, 'German');
    expect(posts.map(({ body }) => [body.revision, body.changes?.length])).toEqual([
      [3, 10],
      [4, 2],
    ]);
    expect(result.batch).toMatchObject({ status: 'scheduled', revision: 5, contentRevision: 1 });
  });

  it('stops at a refused chunk and names what was saved and what was not', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Capped');
    const changes = hashes(30).map((hash) => change(hash, `New ${hash}`));
    const error = await api
      .saveToBatch(batch.id, batch.revision, 'draft', changes, 'Stage')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(api.PartialBatchSave);
    const partial = error as InstanceType<typeof api.PartialBatchSave>;
    expect(partial.saved.accepted).toEqual(hashes(15));
    expect(partial.unsaved).toEqual(hashes(15, 115));
    // The Worker's own words.
    expect(partial.message).toBe('A batch holds at most 15 tooltips');
    expect(fixture.members.get(batch.id)?.size).toBe(15);
  });

  it('refuses the first chunk as the Worker worded it, with nothing saved', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Stale revision');
    const error = await api
      .saveToBatch(batch.id, 7, 'draft', [change(100, 'New')], 'Stage')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(api.BatchRefusal);
    expect(error).toMatchObject({
      status: 409,
      message: 'The batch changed; reload it and retry',
      revision: 1,
    });
  });

  it('reports merge conflicts per tooltip', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Conflicts');
    // The client's base is not current at head: the add is refused per tooltip.
    const error = await api
      .saveToBatch(
        batch.id,
        batch.revision,
        'draft',
        [{ hash: 100, base: tooltip(100, 'Older'), next: tooltip(100, 'New') }],
        'Stage',
      )
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ conflicts: true, members: [{ hash: 100, fields: ['$base'] }] });
  });

  it('keeps schedule refusals verbatim with their per-member details', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Stale');
    await api.saveToBatch(batch.id, batch.revision, 'draft', [change(100, 'Batch')], 'm');
    fixture.setCurrent(100, tooltip(100, 'Somebody else'));
    const error = await api
      .scheduleBatch(batch.id, 2, '2026-12-03T16:00:00.000Z', 'UTC')
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      status: 409,
      message: 'Current changed under this batch; rebase the listed tooltips',
      members: [{ hash: 100, fields: ['text.en'] }],
    });
    const early = await api
      .scheduleBatch(batch.id, 2, '2026-11-13T12:01:00.000Z', 'UTC')
      .catch((reason: unknown) => reason);
    expect(early).toMatchObject({ status: 422, message: 'Pick a time at least 3 minutes ahead' });
  });

  it('reads batch.json, archived event pages, and activation conflicts at a head', async () => {
    const api = await load();
    const { batch } = await api.createBatch('Detail');
    await api.saveToBatch(batch.id, batch.revision, 'draft', [change(100, 'Batch')], 'm');
    fixture.addEvents(batch.id, 205);
    const { head } = await api.listBatches();
    const stored = await api.readBatch(head, batch.id);
    expect(stored?.events).toHaveLength(200);
    expect(stored?.events[0].action).toBe('save');
    const older = await api.readArchivedEvents(head, batch.id);
    // create + the first save + 5 of the added ones moved out, oldest first.
    expect(older.map((event) => event.action)).toEqual([
      'create',
      'save',
      'save',
      'save',
      'save',
      'save',
      'save',
    ]);
    expect(await api.readBatch(head, '01JFZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
    // Publish, then RECORD finds current moved: a conflict file.
    await api.scheduleBatch(batch.id, stored!.revision, '2026-12-03T16:00:00.000Z', 'UTC');
    fixture.publish(batch.id);
    fixture.addConflict(batch.id, 100, tooltip(100, 'Edited meanwhile'));
    const later = (await api.listBatches()).head;
    const [conflict, none] = await api.readActivationConflicts(later, [100, 101]);
    expect(conflict).toMatchObject({ hash: 100, batchId: batch.id, fields: ['text.en'] });
    expect(none).toBeNull();
  });
});
