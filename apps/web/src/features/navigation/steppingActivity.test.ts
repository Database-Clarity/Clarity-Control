// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginSteppingFrame,
  holdSteppingKey,
  pulseStepping,
  recordSteppingWorkspaceWork,
  useSteppingActivity,
} from './steppingActivity';

afterEach(() => {
  window.dispatchEvent(new Event('blur'));
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('gives a costly frame and pending physical input room without extending the burst', () => {
  vi.useFakeTimers();
  let pending = false;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  pulseStepping();
  const finish = beginSteppingFrame();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(false);
  vi.advanceTimersByTime(17);
  finish();
  recordSteppingWorkspaceWork(17);
  pulseStepping();
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  vi.advanceTimersByTime(25);
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(false);
  pending = true;
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  vi.advanceTimersByTime(15);
  expect(useSteppingActivity.getState()).toMatchObject({ active: false, deferWorkspace: false });
});

it('catches up on the next free frame and cancels obsolete handoffs on new input', () => {
  vi.useFakeTimers();
  let pending = true;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled = vi.fn();
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    callbacks.set(++nextId, run);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', cancelled);
  pulseStepping();
  beginSteppingFrame()();
  const obsolete = nextId;
  vi.advanceTimersByTime(4);
  pulseStepping();
  expect(cancelled).toHaveBeenCalledWith(obsolete);
  callbacks.get(obsolete)!(0);
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  beginSteppingFrame()();
  pending = false;
  vi.advanceTimersByTime(8);
  callbacks.get(nextId)!(0);
  expect(useSteppingActivity.getState()).toMatchObject({ active: true, deferWorkspace: false });
});

it('coalesces input activity without notifying React until the route frame', () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const unsubscribe = useSteppingActivity.subscribe(changed);
  for (let packet = 0; packet < 300; packet++) pulseStepping();
  expect(changed).not.toHaveBeenCalled();
  beginSteppingFrame()();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(useSteppingActivity.getState()).toMatchObject({ active: true, deferWorkspace: true });
  unsubscribe();
});

it('resumes the URL on a free frame while a costly async document still waits', () => {
  vi.useFakeTimers();
  let pending = true;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    callbacks.set(++nextId, run);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const resume = vi.fn();
  pulseStepping(undefined, resume);
  beginSteppingFrame()();
  recordSteppingWorkspaceWork(30);
  pending = false;
  vi.advanceTimersByTime(9);
  callbacks.get(nextId)!(0);
  expect(resume).toHaveBeenCalledOnce();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  vi.advanceTimersByTime(29);
  callbacks.get(nextId)!(0);
  expect(useSteppingActivity.getState().deferWorkspace).toBe(false);
});

describe('physical navigation key holds', () => {
  it('stays suspended through the initial delay and slow or irregular repeats', () => {
    vi.useFakeTimers();
    holdSteppingKey('ArrowDown');
    vi.advanceTimersByTime(600);
    expect(useSteppingActivity.getState().active).toBe(true);
    for (const gap of [47, 250, 800]) {
      pulseStepping();
      vi.advanceTimersByTime(gap);
      expect(useSteppingActivity.getState().active).toBe(true);
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
    vi.advanceTimersByTime(39);
    expect(useSteppingActivity.getState().active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useSteppingActivity.getState().active).toBe(false);
  });

  it('settles a single tap after 40 ms and ignores unrelated key release', () => {
    vi.useFakeTimers();
    holdSteppingKey('ArrowUp');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
    vi.advanceTimersByTime(100);
    expect(useSteppingActivity.getState().active).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }));
    vi.advanceTimersByTime(40);
    expect(useSteppingActivity.getState().active).toBe(false);
  });

  it.each(['blur', 'visibilitychange', 'modifier', 'dispose'])('releases on %s', (reason) => {
    vi.useFakeTimers();
    const release = holdSteppingKey('ArrowDown');
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
    else if (reason === 'modifier')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    else release();
    vi.advanceTimersByTime(40);
    expect(useSteppingActivity.getState().active).toBe(false);
    release(); // Cleanup after an external release must remain harmless.
    expect(useSteppingActivity.getState().active).toBe(false);
  });
});
