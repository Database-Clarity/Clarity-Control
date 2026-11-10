import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorData, tooltip } from './fixtures.testSupport';

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: { id: number; revision: number; data?: unknown; changes: unknown }[] = [];
  onmessage?: (event: unknown) => void;
  onerror?: () => void;
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: FakeWorker['messages'][number]) {
    this.messages.push(structuredClone(message));
  }
  complete(index: number, issues: unknown[] = []) {
    this.onmessage?.({ data: { id: this.messages[index].id, issues } });
  }
}
beforeEach(() => {
  vi.resetModules();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

it('shares pending/completed verdicts with preparation for exactly the same snapshot', async () => {
  const { requestSaveValidation } = await import('./validationWorker');
  const { prepareChanges } = await import('./pipeline');
  const data = editorData();
  const changes = [{ hash: 123, base: tooltip, next: { ...tooltip, associated: [30] } }];
  const first = requestSaveValidation(changes, data);
  expect(requestSaveValidation(structuredClone(changes), data)).toBe(first);
  const worker = FakeWorker.instances[0];
  worker.complete(0);
  await first;
  await prepareChanges(changes, { id: 1, login: 'editor', role: 'editor' }, data);
  expect(worker.messages).toHaveLength(1);
  changes[0].next.associated = [31];
  const changed = requestSaveValidation(changes, data);
  expect(changed).not.toBe(first);
  expect(worker.messages[1].data).toBeUndefined();
  worker.complete(1);
  await changed;
});
it('reposts a fresh catalogue at the same commit, and correlates out-of-order results', async () => {
  const { requestSaveValidation } = await import('./validationWorker');
  const data = editorData();
  const changes = [{ hash: 123, base: tooltip, next: tooltip }];
  const first = requestSaveValidation(changes, data);
  const fresh = requestSaveValidation(changes, { ...data, bundle: { ...data.bundle } });
  const worker = FakeWorker.instances[0];
  expect(worker.messages[1].data).toBeDefined();
  expect(worker.messages[1].revision).not.toBe(worker.messages[0].revision);
  worker.complete(1, [{ severity: 'error' }]);
  expect(await fresh).toEqual([{ severity: 'error' }]);
  worker.complete(0);
  expect(await first).toEqual([]);
});
it('fails closed on worker errors, and recreates the worker with a full snapshot', async () => {
  const { requestSaveValidation } = await import('./validationWorker');
  const data = editorData();
  const changes = [{ hash: 123, base: tooltip, next: tooltip }];
  const first = requestSaveValidation(changes, data);
  const rejected = expect(first).rejects.toThrow('worker unavailable');
  FakeWorker.instances[0].onerror?.();
  await rejected;
  const retry = requestSaveValidation(changes, data);
  const worker = FakeWorker.instances[1];
  expect(worker.messages[0].data).toBeDefined();
  worker.complete(0);
  await expect(retry).resolves.toEqual([]);
});
it('does not fall back to synchronous validation when workers are absent', async () => {
  vi.stubGlobal('Worker', undefined);
  const { requestSaveValidation } = await import('./validationWorker');
  await expect(requestSaveValidation([], editorData())).rejects.toThrow();
});
