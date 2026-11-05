// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginSteppingFrame,
  holdSteppingKey,
  pulseStepping,
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
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(false);
  pending = true;
  beginSteppingFrame()();
  expect(useSteppingActivity.getState().deferWorkspace).toBe(true);
  vi.advanceTimersByTime(23);
  expect(useSteppingActivity.getState()).toMatchObject({ active: false, deferWorkspace: false });
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
