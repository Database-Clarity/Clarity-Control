import { describe, expect, it } from 'vitest';
import { createWheelStepper } from './stepping';

const pixel = (delta: number) => ({ delta, deltaMode: 0 });

describe('wheel stepper', () => {
  it('steps once per mouse notch and keeps a fast spin controllable', () => {
    const stepper = createWheelStepper();
    expect(stepper.feed(pixel(100), 0)).toBe(1);
    expect(stepper.feed(pixel(100), 40)).toBe(0); // inside the cooldown
    expect(stepper.feed(pixel(100), 300)).toBe(1);
    expect(stepper.feed(pixel(-100), 600)).toBe(-1);
  });
  it('treats Firefox line deltas (3 lines per notch) as one notch', () => {
    const stepper = createWheelStepper();
    expect(stepper.feed({ delta: 3, deltaMode: 1 }, 0)).toBe(1);
  });
  it('advances one tooltip for a whole trackpad flick, even with momentum', () => {
    const stepper = createWheelStepper();
    let steps = 0;
    for (let at = 0; at < 1200; at += 16) steps += Math.abs(stepper.feed(pixel(12), at));
    expect(steps).toBe(1);
  });
  it('steps again once the flick has settled', () => {
    const stepper = createWheelStepper();
    const run = (from: number) => {
      let steps = 0;
      for (let at = from; at < from + 600; at += 16) steps += Math.abs(stepper.feed(pixel(12), at));
      return steps;
    };
    expect(run(0)).toBe(1);
    expect(run(1500)).toBe(1);
  });
  it('ignores zero deltas and restarts accumulation when the direction flips', () => {
    const stepper = createWheelStepper();
    expect(stepper.feed(pixel(0), 0)).toBe(0);
    expect(stepper.feed(pixel(60), 10)).toBe(0);
    expect(stepper.feed(pixel(-60), 20)).toBe(0);
    expect(stepper.feed(pixel(-60), 30)).toBe(-1);
  });
});
