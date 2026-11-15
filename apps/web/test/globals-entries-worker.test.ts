// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  createGlobalImpactProjector,
  type GlobalProjectionInput,
  type GlobalsImpactReply,
  type GlobalsImpactRequest,
} from '../src/services/globals';
import { createGlobalsFixture } from './globals-entries-fixture';
import coreFixture from '../../../packages/core/src/globals/contract.fixture.json';
import { globalImpactSchema } from '@clarity/core';

class FakeWorker {
  onmessage: ((event: MessageEvent<GlobalsImpactReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: GlobalsImpactRequest[] = [];
  terminate = vi.fn();
  postMessage(input: GlobalsImpactRequest) {
    this.messages.push(input);
  }
  reply(id: number, result = globalImpactSchema.parse(coreFixture.impact)) {
    this.onmessage?.({ data: { id, result } } as MessageEvent<GlobalsImpactReply>);
  }
}
const input = (): GlobalProjectionInput =>
  createGlobalsFixture(null).projection.prepare({
    expectedHead: 'fixture-head-1',
    id: 'g_damage0001',
    revision: 'r1',
    lang: 'en',
    body: '25%',
  });
afterEach(() => vi.unstubAllGlobals());

it('terminates superseded work and ignores late or mismatched replies', async () => {
  const workers: FakeWorker[] = [];
  const projector = createGlobalImpactProjector(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const first = projector.calculate(input()).catch((error: DOMException) => error);
  const second = projector.calculate(input());
  expect(await first).toMatchObject({ name: 'AbortError' });
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  workers[0].reply(1);
  workers[1].reply(1);
  expect(workers[1].terminate).not.toHaveBeenCalled();
  workers[1].reply(2);
  expect((await second).complete).toBe(true);
  expect(workers[1].terminate).toHaveBeenCalledTimes(1);
  projector.dispose();
  expect(workers[1].terminate).toHaveBeenCalledTimes(1);
});

it('cancels on AbortSignal or disposal and reports worker failure without a main-thread fallback', async () => {
  const worker = new FakeWorker();
  const projector = createGlobalImpactProjector(() => worker as unknown as Worker);
  const controller = new AbortController();
  const cancelled = projector
    .calculate(input(), controller.signal)
    .catch((error: DOMException) => error);
  controller.abort();
  expect(await cancelled).toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  const failed = projector.calculate(input()).catch((error: Error) => error);
  worker.onerror?.({
    message: 'Worker failed to load.',
    preventDefault: vi.fn(),
  } as unknown as ErrorEvent);
  expect(await failed).toMatchObject({ message: 'Worker failed to load.' });
  const disposed = projector.calculate(input()).catch((error: DOMException) => error);
  projector.dispose();
  expect(await disposed).toMatchObject({ name: 'AbortError' });
  const unavailable = createGlobalImpactProjector(() => {
    throw new Error('Worker unavailable.');
  });
  await expect(unavailable.calculate(input())).rejects.toThrow('Worker unavailable.');
});

it('runs the unchanged S1 resolver through the worker message protocol', async () => {
  const scope = {
    postMessage: vi.fn(),
    onmessage: undefined as ((event: MessageEvent<GlobalsImpactRequest>) => void) | undefined,
  };
  vi.stubGlobal('self', scope);
  await import('../src/services/globalsImpact.worker');
  const request = input();
  scope.onmessage!({ data: { id: 7, input: request } } as MessageEvent<GlobalsImpactRequest>);
  const reply = scope.postMessage.mock.calls[0][0] as GlobalsImpactReply;
  expect(reply.id).toBe(7);
  expect(reply.error).toBeUndefined();
  const result = globalImpactSchema.parse(reply.result);
  expect(result.complete).toBe(true);
  expect(
    result.rows.some((row) => row.consumer.hash === 10 && row.after?.rendered.includes('25%')),
  ).toBe(true);
  request.changes[0].beforeName = 'invalid#name';
  scope.onmessage!({ data: { id: 8, input: request } } as MessageEvent<GlobalsImpactRequest>);
  expect(scope.postMessage.mock.calls[1][0]).toEqual({
    id: 8,
    error: 'Invalid changed global name',
  });
});
