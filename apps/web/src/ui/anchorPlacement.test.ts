import { describe, expect, it } from 'vitest';
import { placeAnchored, visibleArea, type PlacementArea } from './anchorPlacement';

// A 390x772 phone, 8px edges.
const area: PlacementArea = { top: 8, bottom: 764, width: 390, layoutHeight: 772, edge: 8 };
const rect = (top: number, height = 36, left = 340, width = 36) => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
});

describe('placeAnchored', () => {
  it('opens below a trigger near the top, the page width less both edges', () => {
    const placed = placeAnchored({ trigger: rect(44), area, width: Infinity, height: 300 });
    expect(placed).toEqual({
      side: 'below',
      left: 8,
      width: 374,
      top: 84,
      bottom: 'auto',
      maxHeight: 764 - 84,
    });
  });

  it('opens above a trigger near the bottom when the content does not fit below', () => {
    const placed = placeAnchored({ trigger: rect(600), area, width: Infinity, height: 300 });
    expect(placed.side).toBe('above');
    // Held by its bottom edge 4px over the trigger, so content that grows grows upward.
    expect(placed.top).toBe('auto');
    expect(placed.bottom).toBe(772 - 596);
    expect(placed.maxHeight).toBe(596 - 8);
  });

  it('stays below when the content fits there, even with more room above', () => {
    const placed = placeAnchored({ trigger: rect(500), area, width: Infinity, height: 100 });
    expect(placed.side).toBe('below');
    expect(placed.top).toBe(540);
  });

  it('keeps the side with more room when neither fits, and scrolls inside', () => {
    const below = placeAnchored({ trigger: rect(300), area, width: Infinity, height: 2000 });
    expect(below.side).toBe('below');
    expect(below.maxHeight).toBe(764 - 340);
    const above = placeAnchored({ trigger: rect(420), area, width: Infinity, height: 2000 });
    expect(above.side).toBe('above');
    expect(above.maxHeight).toBe(416 - 8);
  });

  it('respects the keyboard: a smaller visible bottom sends it above', () => {
    const keyboard = { ...area, bottom: 480 - 52 - 8 };
    const placed = placeAnchored({
      trigger: rect(380),
      area: keyboard,
      width: Infinity,
      height: 200,
    });
    expect(placed.side).toBe('above');
    expect(placed.maxHeight).toBe(376 - 8);
  });

  it('opens above a trigger on the docked bar, flush with gap 0', () => {
    const docked = { ...area, top: 124, bottom: 772 - 52 - 8 };
    const placed = placeAnchored({
      trigger: rect(720, 52),
      area: docked,
      width: Infinity,
      gap: 0,
    });
    expect(placed).toMatchObject({ side: 'above', bottom: 52, maxHeight: 720 - 124 });
  });

  it('keeps its own width when smaller, lined up with the trigger and clamped to the edges', () => {
    const end = placeAnchored({ trigger: rect(44, 36, 300, 60), area, width: 320 });
    expect(end).toMatchObject({ left: 40, width: 320 });
    const start = placeAnchored({
      trigger: rect(44, 36, 100, 36),
      area,
      width: 320,
      align: 'start',
    });
    expect(start).toMatchObject({ left: 390 - 320 - 8, width: 320 });
    const left = placeAnchored({ trigger: rect(44, 36, 4, 36), area, width: 320, align: 'start' });
    expect(left.left).toBe(8);
  });

  it('matches the desktop placement: 560 wide, right-aligned, below with the room left', () => {
    const desktop = { top: 8, bottom: 792, width: 1280, layoutHeight: 800, edge: 8 };
    const placed = placeAnchored({
      trigger: { top: 60, bottom: 88, left: 900, right: 980 },
      area: desktop,
      width: 560,
    });
    expect(placed).toEqual({
      side: 'below',
      left: 420,
      width: 560,
      top: 92,
      bottom: 'auto',
      maxHeight: 800 - 88 - 4 - 8,
    });
  });
});

describe('visibleArea', () => {
  const fakeWindow = (
    viewport: { offsetTop: number; height: number } | null,
    dock = '',
    phone = true,
  ) =>
    ({
      innerWidth: 390,
      innerHeight: 772,
      visualViewport: viewport,
      matchMedia: () => ({ matches: phone }),
      document: { documentElement: {} },
      getComputedStyle: () => ({
        getPropertyValue: () => dock,
        fontSize: '16px',
      }),
    }) as unknown as Window;

  it('uses the visual viewport (iOS keyboard) less the docked bar', () => {
    const result = visibleArea(fakeWindow({ offsetTop: 0, height: 436 }, '52px'));
    expect(result.bottom).toBe(436 - 52 - result.edge);
    expect(result.layoutHeight).toBe(772);
  });

  it('follows a panned visual viewport', () => {
    const result = visibleArea(fakeWindow({ offsetTop: 120, height: 436 }));
    expect(result.top).toBe(120 + result.edge);
    expect(result.bottom).toBe(556 - result.edge);
  });

  it('takes a raised top as given (no edge gap)', () => {
    expect(visibleArea(fakeWindow({ offsetTop: 0, height: 772 }), 124).top).toBe(124);
  });

  it('ignores the dock on desktop', () => {
    const result = visibleArea(fakeWindow({ offsetTop: 0, height: 772 }, '52px', false));
    expect(result).toMatchObject({ top: 8, bottom: 764, edge: 8 });
  });
});
