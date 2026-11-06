import { afterEach, expect, it, vi } from 'vitest';
import { backgroundDecodePaused, createPaneDecodeGuard } from './paneDecodeActivity';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('resumes only after the newest pane commits, rejecting a superseded frame', () => {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const guard = createPaneDecodeGuard();
  try {
    guard.begin(1);
    guard.committed(1);
    const stale = frames.get(1)!;
    guard.begin(2);
    guard.committed(1);
    expect(frames.size).toBe(0);
    guard.committed(2);
    stale(0);
    vi.runAllTimers();
    expect(backgroundDecodePaused()).toBe(true);
    frames.get(2)!(16);
    expect(backgroundDecodePaused()).toBe(true);
    vi.runAllTimers();
    expect(backgroundDecodePaused()).toBe(false);
    // Query/language changes and alias redirects can keep the same entry.
    guard.begin(2);
    expect(backgroundDecodePaused()).toBe(false);
  } finally {
    guard.dispose();
  }
});

it('releases an unmounted pane without releasing another pane', () => {
  const first = createPaneDecodeGuard(),
    second = createPaneDecodeGuard();
  first.begin(1);
  second.begin(2);
  first.dispose();
  first.dispose();
  expect(backgroundDecodePaused()).toBe(true);
  second.dispose();
  expect(backgroundDecodePaused()).toBe(false);
});
