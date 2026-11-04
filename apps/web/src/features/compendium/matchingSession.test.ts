import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { emptyProgress } from './reviewProgress';
import { sendWorkerResult } from './workerReplies';

afterEach(() => vi.unstubAllGlobals());
it('shares a worker across views and avoids resending results for empty guidance or selection changes', async () => {
  vi.resetModules();
  const requests: Record<string, unknown>[] = [];
  const terminate = vi.fn();
  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    terminate = terminate;
    postMessage(data: Record<string, unknown>) {
      requests.push(data);
      if (!data.id) return;
      queueMicrotask(() =>
        sendWorkerResult(
          (reply) => this.onmessage?.({ data: reply } as MessageEvent),
          data.id as number,
          data.initialize ? new Map() : { matches: new Map(), decisions: [] },
        ),
      );
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const { matchingSession } = await import('./matchingSession');
  const f = guidedFixture();
  const first = matchingSession(f.editor, f.source);
  expect(matchingSession(f.editor, f.source)).toBe(first);
  const input = { drafts: {}, progress: emptyProgress(), scope: f.scope };
  const a = first.display(input);
  await a;
  const b = first.display({
    ...input,
    progress: { ...input.progress, selected: 101, query: 'sample' },
    local: { version: 1, scope: f.scope, baseline: '', categories: {} },
  });
  expect(b).toBe(a);
  expect(requests.filter((request) => request.id)).toHaveLength(2);
  expect(requests.some((request) => request.editor || request.source)).toBe(false);
  await first.display({ ...input, local: f.document });
  expect(requests.filter((request) => request.id)).toHaveLength(3);
  const reloaded = matchingSession(f.editor, { ...f.source });
  expect(reloaded).not.toBe(first);
  expect(terminate).toHaveBeenCalledTimes(1);
  await reloaded.proposals;
});

it('initializes and reloads editor inputs in the retained source worker using transferred bytes', async () => {
  vi.resetModules();
  const f = guidedFixture();
  const chunks = new Map<number, Uint8Array[]>();
  const initialized: Record<string, unknown>[] = [];
  const terminate = vi.fn();
  class RetainedWorker {
    onmessage?: (event: MessageEvent) => void;
    terminate = terminate;
    postMessage(message: Record<string, unknown>, transfer: Transferable[] = []) {
      const data = structuredClone(message, { transfer });
      if (data.initialChunk) {
        const { token, bytes } = data.initialChunk as { token: number; bytes: ArrayBuffer };
        const parts = chunks.get(token) ?? [];
        parts.push(new Uint8Array(bytes));
        chunks.set(token, parts);
      } else if (data.initialize) {
        const { token } = data.initialize as { token: number };
        initialized.push(
          JSON.parse(
            chunks
              .get(token)!
              .map((part) => new TextDecoder().decode(part))
              .join(''),
          ),
        );
        queueMicrotask(() =>
          sendWorkerResult(
            (reply) => this.onmessage?.({ data: reply } as MessageEvent),
            data.id as number,
            new Map(),
          ),
        );
      }
    }
  }
  const worker = new RetainedWorker();
  const { createWorkerBridge, bindSourceWorker } = await import('./workerBridge');
  const bridge = createWorkerBridge(worker as unknown as Worker);
  bindSourceWorker(f.source, bridge);
  const construct = vi.fn(() => {
    throw new Error('A second source worker must not be created');
  });
  vi.stubGlobal('Worker', construct);
  const { matchingSession } = await import('./matchingSession');
  await matchingSession(f.editor, f.source).proposals;
  await matchingSession(
    { ...f.editor, bundle: { ...f.editor.bundle, sourceCommit: 'reloaded' } },
    f.source,
  ).proposals;
  expect(construct).not.toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled();
  expect(initialized).toHaveLength(2);
  expect(initialized[0].editor).toEqual(JSON.parse(JSON.stringify(f.editor)));
  expect(initialized.every((input) => !('source' in input))).toBe(true);
  bridge.dispose();
});

it('initializes before source delivery and reuses the early retained session once bound', async () => {
  vi.resetModules();
  const f = guidedFixture();
  let initialized!: (value: { id: number }) => void;
  const started = new Promise<{ id: number }>((resolve) => {
    initialized = resolve;
  });
  const worker = {
    postMessage: vi.fn((value: { id: number; initialize?: unknown }) => {
      if (value.initialize) initialized(value);
    }),
    terminate: vi.fn(),
  } as unknown as Worker;
  const { createWorkerBridge, bindSourceWorker } = await import('./workerBridge');
  const { matchingSession, prewarmMatchingSession } = await import('./matchingSession');
  const bridge = createWorkerBridge(worker);
  prewarmMatchingSession(f.editor, bridge);
  prewarmMatchingSession(f.editor, bridge);
  const initialize = await started;
  // A source object is only made available to the UI after initialization has begun.
  bindSourceWorker(f.source, bridge);
  const session = matchingSession(f.editor, f.source);
  const requests = vi.mocked(worker.postMessage).mock.calls.map(([value]) => value);
  expect(requests.filter((value) => value.initialize)).toHaveLength(1);
  const chunks = requests
    .filter((value) => value.initialChunk)
    .map((value) => new Uint8Array(value.initialChunk.bytes));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(
    JSON.parse(JSON.stringify({ editor: f.editor })),
  );
  sendWorkerResult(
    (data) => worker.onmessage!.call(worker, { data } as MessageEvent),
    initialize.id,
    new Map(),
  );
  expect(await session.proposals).toEqual(new Map());
  expect(worker.terminate).not.toHaveBeenCalled();
  session.dispose();
});
