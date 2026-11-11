// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compendiumInputPaused,
  trackCompendiumInput,
  useCompendiumSurface,
} from './backgroundActivity';
import { createWorkerBridge } from './workerBridge';
import { streamInputs } from './streamInputs';
import { useCompendiumCount } from './CompendiumBadge';
import { useCompendiumStore } from './store';
import { useDataStore, type EditorData } from '../../stores/data';
vi.mock('./useDisplayMatches', () => ({ useDisplayMatches: () => ({ prepared: null }) }));
vi.mock('../../services/compendium', async (original) => ({
  ...(await original<object>()),
  pendingCompendiumWorker: () => undefined,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('defers background input transfer and queued decoding until the last key is quiet', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const tasks: (() => void)[] = [];
  vi.stubGlobal('scheduler', {
    postTask: (callback: () => void) => {
      tasks.push(callback);
      return Promise.resolve();
    },
  });
  const input = document.createElement('textarea');
  document.body.append(input);
  const stop = trackCompendiumInput();
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  const reply = bridge.request<string>({ input: {} });
  worker.onmessage!.call(worker, { data: { id: 1, value: 'same result' } } as MessageEvent);
  expect(tasks).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  expect(compendiumInputPaused()).toBe(true);
  tasks.shift()!();
  const transferred = vi.fn();
  const transfer = streamInputs({ text: 'unchanged' }, transferred, () => false);
  await Promise.resolve();
  expect(transferred).not.toHaveBeenCalled();
  expect(tasks).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(80);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  await vi.advanceTimersByTimeAsync(80);
  expect(compendiumInputPaused()).toBe(true);
  expect(transferred).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25);
  expect(compendiumInputPaused()).toBe(false);
  while (tasks.length) tasks.shift()!();
  expect(await reply).toBe('same result');
  await transfer;
  expect(transferred).toHaveBeenCalledTimes(1);
  bridge.dispose();
  stop();
  input.remove();
});

it('does not start Compendium preparation without a visible surface', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  const original = useCompendiumStore.getState();
  const originalData = useDataStore.getState();
  const load = vi.fn(async () => {});
  useDataStore.setState({ data: { bundle: { tooltips: {} } } as unknown as EditorData });
  useCompendiumStore.setState({ data: null, error: null, load });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View({ visible }: { visible: boolean }) {
    useCompendiumSurface(visible);
    useCompendiumCount();
    return null;
  }
  try {
    await act(async () => root.render(<View visible={false} />));
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.render(<View visible />));
    expect(load).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useCompendiumStore.setState(original);
    useDataStore.setState(originalData);
  }
});
