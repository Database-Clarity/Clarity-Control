// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preloadWorkspaces } from './workspacePreload';

let frames: FrameRequestCallback[];
let callbacks: Map<number, IdleRequestCallback>;
let nextId: number;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  callbacks = new Map();
  nextId = 0;
  document.body.innerHTML = '<main><h1>Editor ready</h1></main>';
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frames.push(run);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('requestIdleCallback', (run: IdleRequestCallback) => {
    callbacks.set(++nextId, run);
    return nextId;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => callbacks.delete(id));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
const paint = () => {
  frames.shift()!(0);
  frames.shift()!(16);
};
async function idle(remaining = 20) {
  const [id, run] = callbacks.entries().next().value!;
  callbacks.delete(id);
  run({ didTimeout: false, timeRemaining: () => remaining });
  await vi.advanceTimersByTimeAsync(0);
}

it('uses short high-refresh idle windows but yields when time is exhausted or input is pending', async () => {
  const load = vi.fn(async () => {});
  const isInputPending = vi.fn(() => false);
  vi.stubGlobal('navigator', { scheduling: { isInputPending } });
  stop = preloadWorkspaces([load]);
  paint();
  await idle(0);
  expect(load).not.toHaveBeenCalled();
  isInputPending.mockReturnValue(true);
  await idle(6.7);
  expect(load).not.toHaveBeenCalled();
  isInputPending.mockReturnValue(false);
  await idle(6.7);
  expect(load).toHaveBeenCalledOnce();
});

it('waits for first paint and runs every loader sequentially in its supplied order', async () => {
  const order: number[] = [];
  let finish!: () => void;
  const first = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        order.push(1);
        finish = resolve;
      }),
  );
  const second = vi.fn(async () => {
    order.push(2);
  });
  stop = preloadWorkspaces([first, second]);
  expect(callbacks.size).toBe(0);
  paint();
  await idle();
  expect(order).toEqual([1]);
  expect(callbacks.size).toBe(0);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  await idle();
  expect(order).toEqual([1, 2]);
});

it('pauses queued work throughout input bursts and cancels on role/unmount cleanup', async () => {
  const load = vi.fn(async () => {});
  stop = preloadWorkspaces([load]);
  paint();
  window.dispatchEvent(new Event('keydown'));
  expect(callbacks.size).toBe(0);
  await vi.advanceTimersByTimeAsync(200);
  window.dispatchEvent(new Event('wheel'));
  await vi.advanceTimersByTimeAsync(200);
  expect(callbacks.size).toBe(0);
  await vi.advanceTimersByTimeAsync(50);
  expect(callbacks.size).toBe(1);
  stop();
  expect(callbacks.size).toBe(0);
  expect(load).not.toHaveBeenCalled();
});

it.each([{ saveData: true }, { effectiveType: '2g' }, { effectiveType: '3g' }, { downlink: 1 }])(
  'skips constrained connections: %j',
  (connection) => {
    vi.stubGlobal('navigator', { connection });
    const load = vi.fn(async () => {});
    stop = preloadWorkspaces([load]);
    expect(frames).toHaveLength(0);
    expect(callbacks.size).toBe(0);
  },
);

it('uses the reported 4G class without rejecting its rounded bandwidth estimate', async () => {
  vi.stubGlobal('navigator', {
    connection: { effectiveType: '4g', downlink: 1.45, saveData: false },
  });
  const load = vi.fn(async () => {});
  stop = preloadWorkspaces([load]);
  paint();
  await idle();
  expect(load).toHaveBeenCalledOnce();
});

it('does not preload while the first route still shows its loading state', async () => {
  document.body.innerHTML = '<main><p role="status">Loading page…</p></main>';
  const load = vi.fn(async () => {});
  stop = preloadWorkspaces([load]);
  paint();
  await idle();
  expect(load).not.toHaveBeenCalled();
  document.querySelector('main')!.innerHTML = '<h1>Ready</h1>';
  await vi.advanceTimersByTimeAsync(0);
  await idle();
  expect(load).not.toHaveBeenCalled();
  paint();
  await idle();
  expect(load).toHaveBeenCalledOnce();
});

it('uses idle time after workspace paint while asynchronous reference matching continues', async () => {
  document.body.innerHTML = '<main><h1>Editor</h1><p role="status">Matching Compendium…</p></main>';
  const load = vi.fn(async () => {});
  stop = preloadWorkspaces([load]);
  paint();
  await idle();
  expect(load).toHaveBeenCalledOnce();
});
