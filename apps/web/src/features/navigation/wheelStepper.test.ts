import { describe, expect, it } from 'vitest';
import { createWheelStepper } from './stepping';

const pixel = (deltaY: number, wheelDeltaY?: number) => ({
  deltaY,
  deltaX: 0,
  deltaMode: 0,
  wheelDeltaY,
});
const play = (deltas: number[], legacy = false) => {
  const stepper = createWheelStepper();
  return deltas.map((delta, index) =>
    stepper.feed(pixel(delta, legacy ? -delta * 3 : undefined), index * 16),
  );
};

describe('wheel stepper', () => {
  it.each([100, 120, 80, 125, 48, 57, 48.5])(
    'steps immediately for each %s px mouse notch, including ten in 300 ms',
    (delta) => {
      const stepper = createWheelStepper();
      for (let i = 0; i < 10; i++) expect(stepper.feed(pixel(delta), i * 30)).toBe(1);
      expect(stepper.feed(pixel(-delta), 301)).toBe(-1);
    },
  );
  it('handles Firefox pixel-mode notch variation without accumulating two notches', () => {
    expect(play([48, 57, 48, 50, 57, 48])).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it.each([1, 2])('treats every line/page event as a discrete step (mode %s)', (deltaMode) => {
    const stepper = createWheelStepper();
    for (const [i, delta] of [1, 3, 0.5, -1].entries()) {
      expect(stepper.feed({ ...pixel(delta), deltaMode }, i)).toBe(Math.sign(delta));
    }
  });
  it('preserves notch signals regardless of scaled pixel distance or smooth state', () => {
    const stepper = createWheelStepper();
    for (let i = 0; i < 12; i++) stepper.feed(pixel(6.25, -18.75), i * 16);
    for (const [i, delta] of [1, 16.7, 33, 48.3, 20, 12].entries()) {
      expect(stepper.feed(pixel(delta, -120), 193 + i)).toBe(1);
    }
  });
  it('supports Shift-remapped X deltas with either legacy axis', () => {
    const stepper = createWheelStepper();
    expect(stepper.feed({ deltaY: 0, deltaX: 5, deltaMode: 0, wheelDeltaX: -120 }, 0)).toBe(1);
    expect(stepper.feed({ deltaY: 0, deltaX: -5, deltaMode: 0, wheelDeltaY: 120 }, 1)).toBe(-1);
    expect(stepper.feed({ deltaY: 0, deltaX: 80, deltaMode: 0 }, 2)).toBe(1);
  });
  it('uses distance for sustained trackpad input, preserving the remainder', () => {
    const result = play(Array<number>(50).fill(12));
    expect(result.reduce((a, b) => a + b, 0)).toBe(6);
    expect(result.slice(0, 8)).toEqual(Array<number>(8).fill(0));
    expect(result[8]).toBe(1);
    expect(result[16]).toBe(1);
  });
  it('bounds a macOS trackpad flick and ignores its long momentum tail', () => {
    const active = [2.5, 7.5, 18.25, 35.5, 62.25, 83.5, 65, 51, 39];
    const tail = Array.from({ length: 70 }, (_, i) => 28 * 0.94 ** i);
    const result = play([...active, ...tail], true);
    expect(result.reduce((a, b) => a + b, 0)).toBe(3);
    expect(result.slice(active.length)).toEqual(Array<number>(tail.length).fill(0));
  });
  it('bounds a pixel-only accelerated flick with no legacy fields', () => {
    const result = play([8, 24, 95, 76, 58, 43, 30, 22, 15, 10, 5, 2]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(3);
    expect(result.slice(5)).toEqual(Array<number>(7).fill(0));
  });
  it('handles a Magic Mouse smooth swipe without stepping for every event', () => {
    const result = play([1, 3, 7, 12, 18, 24, 28, 25, 21, 17, 13, 9, 6, 3, 1], true);
    expect(result.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('restarts distance on reversal or quiet and lets renewed motion escape momentum', () => {
    const stepper = createWheelStepper();
    expect(stepper.feed(pixel(60, -180), 0)).toBe(0);
    expect(stepper.feed(pixel(-60, 180), 16)).toBe(0);
    expect(stepper.feed(pixel(-60, 180), 32)).toBe(-1);
    for (const [i, delta] of [30, 20, 10, 5].entries())
      stepper.feed(pixel(-delta, delta * 3), 48 + i * 16);
    expect(stepper.feed(pixel(-35, 105), 112)).toBe(0);
    expect(stepper.feed(pixel(-35, 105), 128)).toBe(0);
    expect(stepper.feed(pixel(-35, 105), 144)).toBe(-1);
    expect(stepper.feed(pixel(60, -180), 500)).toBe(0);
    expect(stepper.feed(pixel(60, -180), 516)).toBe(1);
  });
  it('ignores zero and invalid deltas', () => {
    const stepper = createWheelStepper();
    for (const delta of [0, NaN, Infinity]) expect(stepper.feed(pixel(delta), 0)).toBe(0);
  });
});
