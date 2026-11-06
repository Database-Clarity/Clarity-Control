import { afterEach, expect, it, vi } from 'vitest';
import { createWorkerBridge } from './workerBridge';
import { sendWorkerResult } from './workerReplies';
import { createPaneDecodeGuard } from './paneDecodeActivity';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('holds queued background decode through editor input, permits priority, and resumes after quiet', async () => {
  vi.useFakeTimers();
  const callbacks = new Map<string, EventListener>();
  class EditorElement {
    closest(selector: string) {
      return selector === '.cm-content' ? this : null;
    }
  }
  vi.stubGlobal('Element', EditorElement);
  vi.stubGlobal('document', {
    addEventListener: (name: string, callback: EventListener) => callbacks.set(name, callback),
    removeEventListener: (name: string) => callbacks.delete(name),
  });
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => idle.push(callback));
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  try {
    const background = bridge.request({ input: {} });
    const published = vi.fn();
    void background.then(published);
    worker.onmessage!.call(worker, { data: { id: 1, value: 'background' } } as MessageEvent);
    callbacks.get('beforeinput')!({ target: new EditorElement() } as unknown as Event);
    while (idle.length) idle.shift()!({ timeRemaining: () => 50, didTimeout: false });
    const priority = bridge.request({ priority: { hash: 5 } });
    worker.onmessage!.call(worker, { data: { id: 2, value: 'pane' } } as MessageEvent);
    while (idle.length) idle.shift()!({ timeRemaining: () => 50, didTimeout: false });
    expect(await priority).toBe('pane');
    expect(published).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(1);
    while (idle.length) idle.shift()!({ timeRemaining: () => 50, didTimeout: false });
    expect(await background).toBe('background');
  } finally {
    bridge.dispose();
  }
  expect(callbacks.size).toBe(0);
});

it('pauses an active background graph while a pane opens, without blocking its priority reply', async () => {
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
  const bridge = createWorkerBridge(worker),
    guard = createPaneDecodeGuard();
  const shared = { text: 'shared' };
  const catalog = {
    rows: Array.from({ length: 4000 }, (_, hash) => ({ hash, cell: shared })),
    shared,
  };
  const background = bridge.request<typeof catalog>({ input: {} });
  const published = vi.fn();
  void background.then(published);
  sendWorkerResult((data) => worker.onmessage!.call(worker, { data } as MessageEvent), 1, catalog);
  const deadline = { timeRemaining: () => 50, didTimeout: false };
  idle.shift()!(deadline);
  await Promise.resolve();
  expect(published).not.toHaveBeenCalled();
  guard.begin(5);
  try {
    while (idle.length) idle.shift()!(deadline);
    expect(published).not.toHaveBeenCalled();
    const priority = bridge.request({ priority: { hash: 5 } });
    worker.onmessage!.call(worker, { data: { id: 2, value: 'pane' } } as MessageEvent);
    while (idle.length) idle.shift()!(deadline);
    expect(await priority).toBe('pane');
    expect(published).not.toHaveBeenCalled();
    guard.dispose();
    while (idle.length) idle.shift()!(deadline);
    const result = await background;
    expect(result).toEqual(catalog);
    expect(result.rows[3999].cell).toBe(result.shared);
  } finally {
    guard.dispose();
    bridge.dispose();
  }
});

it('does not emit per-chunk instrumentation in production', async () => {
  vi.stubEnv('DEV', false);
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.push(callback);
    return idle.length;
  });
  const mark = vi.spyOn(performance, 'mark'),
    measure = vi.spyOn(performance, 'measure');
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  const pending = bridge.request({ priority: { hash: 5 } });
  worker.onmessage!.call(worker, { data: { id: 1, value: 'pane' } } as MessageEvent);
  while (idle.length) idle.shift()!({ timeRemaining: () => 50, didTimeout: false });
  expect(await pending).toBe('pane');
  expect(mark).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
  bridge.dispose();
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
