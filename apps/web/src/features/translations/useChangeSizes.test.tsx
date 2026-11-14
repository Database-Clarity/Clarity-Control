// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChangeSizes, useSizeOrder, type ChangeSize } from './useChangeSizes';
import type { QueueRow } from './queue';
import type { EditorData } from '../../stores/data';

vi.mock('../../services/apiAuth', () => ({
  authorization: () => ({}),
  endpoint: () => 'https://api.example',
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const jobs: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: { data: { count: number } | { error: string } }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    jobs.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  jobs.length = 0;
});

it('keeps a stable visible order as sizes arrive and sorts only on explicit refresh', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const rows = [{ key: 'first' }, { key: 'second' }] as QueueRow[];
  function Probe({ sizes, refresh }: { sizes: ReadonlyMap<string, ChangeSize>; refresh: number }) {
    const ordered = useSizeOrder(rows, sizes, true, refresh);
    return <p>{ordered.map((row) => row.key).join(',')}</p>;
  }
  await act(async () => root.render(<Probe sizes={new Map()} refresh={0} />));
  expect(host.textContent).toBe('first,second');
  const learned = new Map<string, ChangeSize>([['second', { count: 0 }]]);
  await act(async () => root.render(<Probe sizes={learned} refresh={0} />));
  expect(host.textContent).toBe('first,second');
  await act(async () => root.render(<Probe sizes={learned} refresh={1} />));
  expect(host.textContent).toBe('second,first');
  await act(async () => root.unmount());
});

it('debounces visibility, caps workers, cancels scroll-away, caches hits, and retries failures', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div');
  const root = createRoot(host);
  const rows = [101, 102, 103, 104].map((hash) => ({
    key: `${hash}:de`,
    hash,
    language: 'de',
    state: 'outdated',
  })) as QueueRow[];
  const data = {
    bundle: {
      tooltips: Object.fromEntries(
        rows.map(({ hash }) => [
          hash,
          {
            hash,
            text: { en: { text: `Current ${hash}` }, de: { sourceUpdatedAt: '2026-01-01' } },
          },
        ]),
      ),
    },
  } as unknown as EditorData;
  let hook!: ReturnType<typeof useChangeSizes>;
  function Probe() {
    hook = useChangeSizes(data, true);
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => hook.onVisible(rows));
  await act(async () => vi.advanceTimersByTime(100));
  expect(jobs).toHaveLength(0);
  await act(async () => hook.onVisible([rows[3]!]));
  await act(async () => vi.advanceTimersByTime(180));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.postMessage.mock.calls[0]![0].hash).toBe(104);
  await act(async () => hook.onVisible(rows.slice(0, 3)));
  expect(jobs[0]!.terminate).toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(180));
  expect(jobs).toHaveLength(3);
  await act(async () => jobs[1]!.onmessage?.({ data: { count: 2 } }));
  expect(jobs).toHaveLength(4); // one completion starts only one replacement
  expect(hook.sizes.get('101:de')).toEqual({ count: 2 });
  await act(async () => jobs[2]!.onmessage?.({ data: { error: 'Offline' } }));
  expect(hook.sizes.get('102:de')).toEqual({ error: 'Offline' });
  await act(async () => hook.onVisible([rows[0]!]));
  await act(async () => vi.advanceTimersByTime(180));
  expect(jobs).toHaveLength(4); // cached result, no worker or network
  await act(async () => hook.onVisible([rows[1]!]));
  await act(async () => hook.retryFailed());
  await act(async () => vi.advanceTimersByTime(180));
  expect(jobs).toHaveLength(5);
  await act(async () => root.unmount());
  expect(jobs[4]!.terminate).toHaveBeenCalled();
});
