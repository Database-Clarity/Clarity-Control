import { describe, expect, it, vi } from 'vitest';

import { isSaveDockIdle, trackDockHeight } from './dock';
import type { SaveReview } from './state';

const review: SaveReview = { changes: [], submitted: {} };

describe('isSaveDockIdle', () => {
  it('is idle only with no drafts, no notice and no open review', () => {
    expect(isSaveDockIdle({ count: 0, notice: null, review: null })).toBe(true);
    expect(isSaveDockIdle({ count: 1, notice: null, review: null })).toBe(false);
    expect(isSaveDockIdle({ count: 0, notice: 'Saved 1 tooltip(s).', review: null })).toBe(false);
    expect(isSaveDockIdle({ count: 0, notice: null, review })).toBe(false);
  });
});

describe('trackDockHeight', () => {
  function fakeObserver() {
    const instances: {
      callback: () => void;
      disconnect: ReturnType<typeof vi.fn>;
      observe: ReturnType<typeof vi.fn>;
    }[] = [];
    class Observer {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(public callback: () => void) {
        instances.push(this);
      }
    }
    return { Observer, instances };
  }

  it('applies the measured height immediately and again whenever the dock resizes', () => {
    const { Observer, instances } = fakeObserver();
    const dock = { offsetHeight: 96 };
    const applied: string[] = [];
    trackDockHeight(dock, (height) => applied.push(height), Observer);
    // A wrapped notice or larger text grows the dock far beyond a fixed 5rem allowance.
    dock.offsetHeight = 214;
    instances[0].callback();
    // Idle (display: none) reserves nothing.
    dock.offsetHeight = 0;
    instances[0].callback();
    expect(applied).toEqual(['96px', '214px', '0px']);
    expect(instances[0].observe).toHaveBeenCalledWith(dock, { box: 'border-box' });
  });
  it('stops observing and tolerates a missing ResizeObserver', () => {
    const { Observer, instances } = fakeObserver();
    trackDockHeight({ offsetHeight: 10 }, () => undefined, Observer)();
    expect(instances[0].disconnect).toHaveBeenCalledOnce();
    const applied: string[] = [];
    expect(() =>
      trackDockHeight({ offsetHeight: 7 }, (height) => applied.push(height), undefined)(),
    ).not.toThrow();
    // No observer: leave the stylesheet's fixed fallback instead of freezing one measurement.
    expect(applied).toEqual([]);
  });
});
