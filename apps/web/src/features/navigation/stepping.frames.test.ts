import { afterEach, expect, it, vi } from 'vitest';
import { createStepping } from './stepping';

afterEach(() => vi.useRealTimers());

it('lands only the final wheel target in a frame and preserves the gesture back entry', () => {
  vi.useFakeTimers();
  let paint: (() => void) | undefined;
  const navigate = vi.fn();
  const frames = {
    request: (run: () => void) => {
      paint = run;
      return 1;
    },
    cancel: vi.fn(),
  };
  const stepping = createStepping(navigate, undefined, frames);
  for (let hash = 10; hash < 310; hash++) stepping.step(`/t/${hash}`, `/t/${hash + 1}`);
  expect(navigate).not.toHaveBeenCalled();
  expect(stepping.target).toBe('/t/310');
  paint!();
  expect(navigate.mock.calls).toEqual([['/t/310', { replace: true }]]);
  vi.advanceTimersByTime(1000);
  expect(navigate.mock.calls.slice(1)).toEqual([
    ['/t/10', { replace: true }],
    ['/t/310', { replace: false }],
  ]);
});

it('cancels queued navigation on Back and refuses a frame after the edit epoch changes', () => {
  vi.useFakeTimers();
  let paint: (() => void) | undefined;
  let epoch = 0;
  const navigate = vi.fn();
  const frames = {
    request: (run: () => void) => {
      paint = run;
      return 1;
    },
    cancel: vi.fn(),
  };
  const guard = { allow: () => true, epoch: () => epoch, authorized: (run: () => void) => run() };
  const stepping = createStepping(navigate, guard, frames);
  stepping.step('/t/10', '/t/11');
  epoch++;
  paint!();
  expect(navigate).not.toHaveBeenCalled();
  stepping.step('/t/10', '/t/12');
  stepping.cancel();
  expect(frames.cancel).toHaveBeenCalledWith(1);
  paint!();
  expect(navigate).not.toHaveBeenCalled();
});
