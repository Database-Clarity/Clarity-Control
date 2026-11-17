/**
 * Scheduling off the Worker (sched-actions-contract.md): the client sends a requestId only with
 * the preparation switch ON, decodes the 202 admission, status, and retry answers, and still
 * decodes every legacy (pre-preparation) Worker answer and batch.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { batchSchema } from '@clarity/core/schedule';
import { createBatchFixture, type BatchFixture } from './fixtureWorker.testSupport';

const tooltip = (hash: number, en: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' } },
});
const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

async function load() {
  return import('./api');
}

describe('scheduled batches client: prepared requests', () => {
  let fixture: BatchFixture;
  let posts: { path: string; body: Record<string, unknown> }[];
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    for (const name of ['localStorage', 'sessionStorage'])
      vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
    fixture = createBatchFixture({
      current: { 10: tooltip(10, 'Old'), 11: tooltip(11, 'Old 11') },
      user: { id: 1, login: 'm', role: 'maintainer' },
    });
    posts = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST')
        posts.push({
          path: new URL(request.url).pathname,
          body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
        });
      return fixture.fetch(request);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function draftWithMember(api: Awaited<ReturnType<typeof load>>) {
    const { batch } = await api.createBatch('December');
    const saved = await api.saveToBatch(
      batch.id,
      batch.revision,
      'draft',
      [{ hash: 10, base: tooltip(10, 'Old'), next: tooltip(10, 'New') }],
      'Stage',
    );
    return saved.batch!;
  }

  it('switch OFF: schedules synchronously with no requestId (legacy answer, unchanged flow)', async () => {
    const api = await load();
    const batch = await draftWithMember(api);
    const result = await api.scheduleBatch(
      batch.id,
      batch.revision,
      '2026-12-01T10:00:00.000Z',
      'UTC',
    );
    expect(result.queued).toBeUndefined();
    expect(result.batch.status).toBe('scheduled');
    expect(posts.at(-1)!.body).not.toHaveProperty('requestId');
  });

  it('switch ON: sends a ULID requestId and decodes "Schedule requested" as preparing', async () => {
    (await import('../../stores/auth')).useAuthStore.setState({
      user: { id: 1, login: 'm', role: 'maintainer', schedulePreparation: true },
    });
    const api = await load();
    const batch = await draftWithMember(api);
    const result = await api.scheduleBatch(
      batch.id,
      batch.revision,
      '2026-12-01T10:00:00.000Z',
      'UTC',
    );
    const sent = posts.at(-1)!.body;
    expect(sent.requestId).toMatch(ulid);
    expect(result.queued?.message).toBe('Schedule requested');
    expect(result.queued?.status).toBe('pending');
    expect(result.batch.status).toBe('preparing');
    expect(result.batch.preparation).toMatchObject({ requestId: sent.requestId, kind: 'schedule' });
    // The commit-pinned batch.json decodes too, and status names the outstanding request.
    const listed = await api.listBatches();
    expect(listed.index.batches[0]).toMatchObject({
      status: 'preparing',
      notBefore: '2026-12-01T10:00:00.000Z',
    });
    expect((await api.readBatch(listed.head, batch.id))?.status).toBe('preparing');
    const status = await api.readBatchStatus(batch.id);
    expect(status.request).toMatchObject({
      requestId: sent.requestId,
      status: 'pending',
      attempt: 1,
    });
  });

  it('queues a save as ONE request; members change only when the preparer lands it', async () => {
    (await import('../../stores/auth')).useAuthStore.setState({
      user: { id: 1, login: 'm', role: 'maintainer', schedulePreparation: true },
    });
    const api = await load();
    const { batch } = await api.createBatch('Queued');
    const queued = await api.queueBatchSave(
      batch.id,
      batch.revision,
      [{ hash: 11, base: tooltip(11, 'Old 11'), next: tooltip(11, 'New 11') }],
      'Stage',
    );
    expect(queued.message).toBe('Save queued');
    expect(queued.batch.status).toBe('preparing');
    expect(fixture.members.get(batch.id)?.size).toBe(0);
    fixture.completeRequest(queued.requestId);
    const listed = await api.listBatches();
    expect(listed.index.batches[0]).toMatchObject({ status: 'draft', hashes: [11] });
    expect((await api.readBatchStatus(batch.id)).request).toBeNull();
  });

  it('decodes needs-attention reasons, keeps only a GitHub workflow link, and retries', async () => {
    (await import('../../stores/auth')).useAuthStore.setState({
      user: { id: 1, login: 'm', role: 'maintainer', schedulePreparation: true },
    });
    const api = await load();
    const batch = await draftWithMember(api);
    const { queued } = await api.scheduleBatch(batch.id, batch.revision, 'now', 'UTC');
    fixture.failRequest(
      queued!.requestId,
      [{ reason: 'Runner lost' }],
      true,
      'javascript:alert(1)',
    );
    let status = await api.readBatchStatus(batch.id);
    expect(status.batch.status).toBe('needs_attention');
    expect(status.request).toMatchObject({ retryable: true, reasons: [{ reason: 'Runner lost' }] });
    expect(status.request?.workflowUrl).toBeUndefined();
    const retried = await api.retryBatchRequest(batch.id, status.batch.revision, queued!.requestId);
    expect(retried.batch.status).toBe('preparing');
    expect(retried.request.attempt).toBe(2);
    fixture.failRequest(
      queued!.requestId,
      [{ reason: 'Stale', hash: 10, fields: ['text.en'] }],
      false,
      'https://github.com/o/r/actions/runs/1',
    );
    status = await api.readBatchStatus(batch.id);
    expect(status.request?.workflowUrl).toBe('https://github.com/o/r/actions/runs/1');
    await expect(
      api.retryBatchRequest(batch.id, status.batch.revision, queued!.requestId),
    ).rejects.toMatchObject({ name: 'BatchRefusal', status: 409 });
  });

  it('shows its own admission although the advisory index lags, and reads a result by requestId', async () => {
    (await import('../../stores/auth')).useAuthStore.setState({
      user: { id: 1, login: 'm', role: 'maintainer', schedulePreparation: true },
    });
    const api = await load();
    const batch = await draftWithMember(api);
    const { queued } = await api.scheduleBatch(
      batch.id,
      batch.revision,
      '2026-12-01T10:00:00.000Z',
      'UTC',
    );
    // The fixture index still names the pre-admission draft (contract: admission never writes it).
    const raw = await (await fixture.fetch('https://worker.example/batches')).json();
    expect(raw.index.batches[0]).toMatchObject({ status: 'draft', revision: batch.revision });
    const listed = await api.listBatches();
    expect(listed.index.batches[0]).toMatchObject({
      status: 'preparing',
      revision: queued!.batch.revision,
      notBefore: '2026-12-01T10:00:00.000Z',
    });
    fixture.completeRequest(queued!.requestId);
    const after = await api.listBatches();
    expect(after.index.batches[0].status).toBe('scheduled');
    const { request } = await api.readBatchStatus(batch.id, undefined, queued!.requestId);
    expect(request).toMatchObject({
      status: 'completed',
      result: { revision: after.index.batches[0].revision },
    });
  });

  it('decodes a failed translator save: terminal, batch still scheduled with the failure summary', async () => {
    const api = await load();
    const batch = await draftWithMember(api);
    const scheduled = await api.scheduleBatch(
      batch.id,
      batch.revision,
      '2026-12-01T10:00:00.000Z',
      'UTC',
    );
    expect(scheduled.queued).toBeUndefined();
    (await import('../../stores/auth')).useAuthStore.setState({
      user: { id: 1, login: 'm', role: 'maintainer', schedulePreparation: true },
    });
    const queued = await api.queueBatchSave(
      batch.id,
      scheduled.batch.revision,
      [{ hash: 10, base: tooltip(10, 'New'), next: tooltip(10, 'New') }],
      'Translate',
    );
    fixture.failSaveKeepScheduled(queued.requestId, [{ reason: 'stamp is older than English' }]);
    const { batch: now, request } = await api.readBatchStatus(
      batch.id,
      undefined,
      queued.requestId,
    );
    expect(request).toMatchObject({
      status: 'failed',
      reasons: [{ reason: 'stamp is older than English' }],
    });
    expect(request?.result).toBeUndefined();
    expect(now.status).toBe('scheduled');
    expect(now.lastPreparationFailure?.requestId).toBe(queued.requestId);
  });

  it('decodes a legacy batch.json (no preparation fields) and a preparing one', () => {
    const legacy = {
      id: '01JF0000000000000000000001',
      name: 'Old',
      createdBy: { id: 1, login: 'm' },
      createdAt: '2026-11-01T00:00:00.000Z',
      revision: 1,
      contentRevision: 0,
      status: 'draft',
      notBefore: null,
      zone: null,
      opId: null,
      scheduledContentRevision: null,
      claim: null,
      result: null,
      events: [
        {
          at: '2026-11-01T00:00:00.000Z',
          by: { id: 1, login: 'm' },
          action: 'create',
          revision: 1,
          contentRevision: 0,
        },
      ],
    };
    expect(batchSchema.parse(legacy).preparation).toBeUndefined();
    const preparing = {
      ...legacy,
      revision: 2,
      status: 'preparing',
      preparation: {
        requestId: '01JF0000000000000000000002',
        kind: 'save',
        returnStatus: 'draft',
        requestedAt: '2026-11-01T00:01:00.000Z',
        attempt: 1,
      },
      preparedRequestId: null,
    };
    expect(batchSchema.parse(preparing).status).toBe('preparing');
  });
});
