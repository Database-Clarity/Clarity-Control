import { afterEach, expect, it, vi } from 'vitest';
import { createWorkerBridge } from './workerBridge';
import { sendWorkerResult } from './workerReplies';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('queues transferred results without decoding on message delivery or during input', async () => {
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.push(callback);
    return idle.length;
  });
  let busy = true;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => busy } });
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  const value = { rows: Array.from({ length: 2000 }, (_, i) => ({ hash: i, text: `Name ${i}` })) };
  const pending = bridge.request<typeof value>({ load: { url: 'synthetic' } });
  let published = false;
  void pending.then(() => {
    published = true;
  });
  sendWorkerResult((data) => worker.onmessage!.call(worker, { data } as MessageEvent), 1, value);
  await Promise.resolve();
  expect(published).toBe(false);
  const deadline = { timeRemaining: () => 50, didTimeout: false };
  idle.shift()!(deadline);
  await Promise.resolve();
  expect(published).toBe(false);
  busy = false;
  for (let i = 0; idle.length && i < 10000; i++) idle.shift()!(deadline);
  expect(await pending).toEqual(value);
});

it('preempts a partially decoded catalog for the selected entry, then resumes its graph intact', async () => {
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => false } });
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.push(callback);
    return idle.length;
  });
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.5));
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  const order: string[] = [];
  const cell = { plain: 'Shared cell', runs: [{ text: 'Shared cell' }] };
  const catalog = { rows: Array.from({ length: 4000 }, (_, hash) => ({ hash, cell })), cell };
  const background = bridge.request<typeof catalog>({ input: {} }).then((value) => {
    order.push('catalog');
    return value;
  });
  const emit = (id: number, value: unknown) =>
    sendWorkerResult((data) => worker.onmessage!.call(worker, { data } as MessageEvent), id, value);
  emit(1, catalog);
  const deadline = { timeRemaining: () => 50, didTimeout: false };
  idle.shift()!(deadline);
  expect(order).toEqual([]);
  const priority = bridge.request({ priority: { hash: 100 } }).then((value) => {
    order.push('pane');
    return value;
  });
  worker.onmessage!.call(worker, {
    data: structuredClone({ id: 2, value: new Map([[100, cell]]) }),
  } as MessageEvent);
  for (let i = 0; idle.length && i < 10000; i++) {
    idle.shift()!(deadline);
    await Promise.resolve();
  }
  expect(order).toEqual(['pane', 'catalog']);
  expect(await priority).toEqual(new Map([[100, cell]]));
  const complete = await background;
  expect(complete).toEqual(catalog);
  expect(complete.rows[3999].cell).toBe(complete.cell);
});

it('rejects an owner that was cancelled while its result was queued', async () => {
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.push(callback);
    return idle.length;
  });
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker),
    owner = {};
  const progress = vi.fn();
  const pending = bridge.request({ input: {} }, owner, progress);
  const matches = new Map([[1, 'source']]);
  sendWorkerResult(
    (data) => worker.onmessage!.call(worker, { data } as MessageEvent),
    1,
    { matches },
    matches,
  );
  bridge.cancel(owner);
  await expect(pending).rejects.toThrow('inputs changed');
  for (let i = 0; idle.length && i < 10000; i++)
    idle.shift()!({ timeRemaining: () => 50, didTimeout: false });
  expect(progress).not.toHaveBeenCalled();
});
