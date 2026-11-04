import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { emptyProgress } from './reviewProgress';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';
import approved from './approved-guidance.v1.json';

afterEach(() => vi.unstubAllGlobals());

it('withholds display results after a failed replacement initialization', async () => {
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
