import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { emptyProgress } from './reviewProgress';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';
import approved from './approved-guidance.v1.json';

afterEach(() => vi.unstubAllGlobals());

it('withholds display results after a failed replacement initialization', async () => {
  vi.resetModules();
  const fixture = guidedFixture();
  let failAsset = false;
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (failAsset) throw Error('Computed asset unavailable');
      return new Response('', { status: 404 });
    }),
  );
  const pending = new Map<
    number,
    {
      receive: ReturnType<typeof receiveWorkerResult>;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  const worker = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage(reply: WorkerReply) {
      const request = pending.get(reply.id);
      if (!request) return;
      if (reply.error) {
        pending.delete(reply.id);
        request.reject(Error(reply.error));
        return;
      }
      const result = request.receive(reply);
      if (result.done) {
        pending.delete(reply.id);
        request.resolve(result.value);
      }
    },
  };
  vi.stubGlobal('self', worker);
  await import('./proposals.worker');
  const request = (id: number, data: object) =>
    new Promise((resolve, reject) => {
      pending.set(id, { receive: receiveWorkerResult(), resolve, reject });
      worker.onmessage!({ data: { id, ...data } });
    });
  const initialize = (id: number, editor: typeof fixture.editor) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ editor, source: fixture.source }));
    worker.onmessage!({ data: { initialChunk: { token: id, bytes: bytes.buffer } } });
    return request(id, { initialize: { token: id } });
  };
  await expect(initialize(1, fixture.editor)).resolves.toBeInstanceOf(Map);
  const next = structuredClone(fixture.editor);
  next.items[100].name = 'Changed catalog name';
  failAsset = true;
  await expect(initialize(2, next)).rejects.toThrow('Computed asset unavailable');
  const input = { drafts: {}, progress: emptyProgress(), scope: approved.scope };
  const error = await request(3, { input }).then(
    () => null,
    (error: Error) => error.message,
  );
  expect(error).toMatch(/initializ/i);
  await expect(
    request(4, {
      guide: {
        document: fixture.document,
        baseline: fixture.baseline,
        scope: approved.scope,
        categoryId: fixture.categories[0].id,
        statuses: [],
        restored: [],
      },
    }),
  ).rejects.toThrow(/initializ/i);
  failAsset = false;
  const recovered = await initialize(5, next);
  expect(recovered).toBeInstanceOf(Map);
  const proposals = recovered as Map<number, { match?: unknown }>;
  expect(proposals.has(100)).toBe(true);
  expect(proposals.get(100)?.match).toBeUndefined();
  await expect(request(6, { input })).resolves.toHaveProperty('matches');
});

it('publishes selected review evidence before assets/full proposals, and reprioritizes navigation', async () => {
  vi.resetModules();
  const f = guidedFixture();
  vi.stubGlobal('indexedDB', undefined);
  let release!: () => void;
  const asset = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', async () => { await asset; return new Response('', { status: 404 }); });
  const pending = new Map<number, {
    receive: ReturnType<typeof receiveWorkerResult>;
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  const worker = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage(reply: WorkerReply) {
      const job = pending.get(reply.id);
      if (!job) return;
      if (reply.error) { pending.delete(reply.id); job.reject(Error(reply.error)); return; }
      const result = job.receive(reply);
      if (result.done) { pending.delete(reply.id); job.resolve(result.value); }
    },
  };
  vi.stubGlobal('self', worker);
  await import('./proposals.worker');
  const request = <T>(id: number, data: object) => new Promise<T>((resolve, reject) => {
    pending.set(id, { receive: receiveWorkerResult(), resolve: (value) => resolve(value as T), reject });
    worker.onmessage!({ data: { id, ...data } });
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ editor: f.editor, source: f.source }));
  worker.onmessage!({ data: { initialChunk: { token: 17, bytes: bytes.buffer } } });
  let finished = false;
  const initialized = request(1, { initialize: { token: 17 } }).then(() => { finished = true; });
  const input = { drafts: {}, progress: emptyProgress(), scope: approved.scope,
    local: { ...f.document, scope: approved.scope } };
  type Priority = import('./matchingSessionPlanning').PriorityReview;
  const first = await request<Priority>(2, { priority: { token: 17, hash: 100, input } });
  expect(finished).toBe(false);
  expect(first.entry?.hash).toBe(100);
  expect(first.matches.get(100)?.row.name).toBe('Sample 100');
  const next = await request<Priority>(3, { priority: { token: 17, hash: 102, input } });
  expect(finished).toBe(false);
  expect(next.entry?.hash).toBe(102);
  release();
  await initialized;
  const full = await request<ReturnType<typeof import('./displayMatches').displayMatches>>(4, { input });
  for (const review of [first, next]) {
    expect(review.entry).toEqual(full.categories.flatMap((c) => c.entries).find((e) => e.hash === review.hash));
    expect(review.decision).toEqual(full.decisions.find((d) => d.hash === review.hash));
    expect(review.matches.get(review.hash)?.row).toEqual(full.matches.get(review.hash)?.row);
  }
});
