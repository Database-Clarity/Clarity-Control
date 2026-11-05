// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SkeletonLine,
  SkeletonRegion,
  SkeletonRows,
  skeletonLineWidths,
  skeletonTextShape,
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
  expect(frames.size).toBe(0);
  await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
  expect(host.textContent).toBe('Retained content');
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
