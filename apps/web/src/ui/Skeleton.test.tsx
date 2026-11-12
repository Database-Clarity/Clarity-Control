// @vitest-environment jsdom
import { act, createElement, lazy } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SkeletonBoundary,
  SkeletonSuspense,
  SkeletonLine,
  SkeletonRegion,
  SkeletonRows,
  skeletonLineWidths,
  skeletonTextShape,
  skeletonMinimumMs,
  useSkeletonVisible,
} from './Skeleton';

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function Pending({
  pending,
  entry = 1,
  content = true,
}: {
  pending: boolean;
  entry?: number;
  content?: boolean;
}) {
  const visible = useSkeletonVisible(pending, entry, content);
  return visible ? (
    <SkeletonRegion>
      <SkeletonLine width={58} />
    </SkeletonRegion>
  ) : (
    <span>Retained content</span>
  );
}
async function frame() {
  const [id, callback] = frames.entries().next().value!;
  frames.delete(id);
  await act(async () => callback(0));
}

it('keeps quick results visible and never flashes a skeleton before the second frame', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  expect(host.textContent).toBe('Retained content');
  await frame();
  expect(host.textContent).toBe('Retained content');
  await act(async () => root.render(createElement(Pending, { pending: false })));
  expect(frames.size).toBe(0);
  expect(host.querySelector('[aria-hidden]')).toBeNull();
});

it('reveals on the second frame and retains the region across consecutive entries', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  await frame();
  await frame();
  const region = host.querySelector('[aria-hidden]');
  expect(region).not.toBeNull();
  await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
  expect(host.querySelector('[aria-hidden]')).toBe(region);
  // The newer entry gets its own two frames; ready within them, it shows directly.
  expect(frames.size).toBe(1);
  await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
  expect(host.textContent).toBe('Retained content');
});

describe('minimum visible time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const shown = () => host.querySelector('[aria-hidden]') !== null;

  it('keeps a shown skeleton for the minimum when the load finishes early, then swaps in', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.render(createElement(Pending, { pending: false })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 101));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe('Retained content');
  });

  it('swaps in at once after a slow load that outlasted the minimum', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs + 500));
    await act(async () => root.render(createElement(Pending, { pending: false })));
    expect(host.textContent).toBe('Retained content');
  });

  it('starts over for a step during the minimum: a slow entry gets a fresh minimum, no stacking', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(50));
    await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 50));
    expect(host.textContent).toBe('Retained content');
  });

  it('shows a first load at once and keeps it for the minimum', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true, content: false })));
    await act(async () => root.render(createElement(Pending, { pending: false, content: false })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(shown()).toBe(false);
  });
});

it('shows first loads immediately without requesting a frame', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true, content: false })));
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
  expect(frames.size).toBe(0);
});

it('cancels a superseded reveal and starts the newer entry window', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  await frame();
  await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
  expect(frames.size).toBe(1);
  await frame();
  expect(host.textContent).toBe('Retained content');
  await frame();
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
});

it('sizes known text from character counts, preserves blank rows, and handles wrapping', () => {
  expect(skeletonLineWidths(skeletonTextShape('abcdefghij\n\nabc'), 100, 10)).toEqual([46, 0, 14]);
  expect(skeletonLineWidths(skeletonTextShape('a'.repeat(50)), 100, 10)).toEqual([100, 100, 28]);
  expect(skeletonLineWidths(skeletonTextShape('abcdefghij', 1), 100, 10)).toEqual([49]);
});

it('bounds table rows to the cached viewport capacity and hides all bars from accessibility', async () => {
  await act(async () =>
    root.render(
      <SkeletonRegion>
        <SkeletonRows count={50} maxRows={4} />
      </SkeletonRegion>,
    ),
  );
  expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  expect(host.firstElementChild?.children).toHaveLength(4);
});

it('removes old content immediately, skips fast-load shimmer, and exposes errors immediately', async () => {
  const render = (pending: boolean, identity: number, error = false) =>
    act(async () =>
      root.render(
        createElement(
          SkeletonBoundary,
          { pending, identity, error, label: 'Loading item' },
          createElement('p', null, error ? 'Failed' : `Item ${identity}`),
        ),
      ),
    );
  await render(false, 1);
  expect(host.textContent).toBe('Item 1');
  await render(true, 2);
  expect(host.textContent).not.toContain('Item 1');
  expect(host.querySelector('[aria-hidden]')).toBeNull();
  await frame();
  await render(false, 2);
  expect(host.textContent).toBe('Item 2');
  await render(true, 3);
  await frame();
  await frame();
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
  await render(false, 3, true);
  expect(host.textContent).toBe('Failed');
});

it('keeps resolved children behind the shown skeleton until its minimum elapses', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let resolve!: (value: { default: () => React.ReactElement }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => React.ReactElement }>((done) => {
          resolve = done;
        }),
    );
    await act(async () =>
      root.render(createElement(SkeletonSuspense, { label: 'Loading page', children: createElement(Page) })),
    );
    await frame();
    await frame();
    await act(async () => resolve({ default: () => createElement('p', null, 'Ready') }));
    expect(host.querySelector('[hidden]')?.textContent).toBe('Ready');
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(host.querySelector('[hidden]')).toBeNull();
    expect(host.textContent).toBe('Ready');
  } finally {
    vi.useRealTimers();
  }
});
