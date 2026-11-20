import { describe, expect, it } from 'vitest';
import {
  placeAnchored,
  placeAtPointer,
  POINTER_CLEARANCE,
  POINTER_OFFSET,
  viewportWidth,
  visibleArea,
  type PlacementArea,
} from './anchorPlacement';

// A 390x772 phone, 8px edges.
const area: PlacementArea = { top: 8, bottom: 764, width: 390, layoutHeight: 772, edge: 8 };
const rect = (top: number, height = 36, left = 340, width = 36) => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
});

describe('placeAtPointer', () => {
  const desk: PlacementArea = { top: 8, bottom: 792, width: 1265, layoutHeight: 800, edge: 8 };
  // The drawn pointer: down and right of the hotspot, POINTER_OFFSET.y tall.
  const underPointer = (p: ReturnType<typeof placeAtPointer>, x: number, y: number, h: number) => {
    const top = p.top === 'auto' ? desk.layoutHeight - (p.bottom as number) - h : p.top;
    return x + 12 > p.left && x < p.left + p.width && y + POINTER_OFFSET.y > top && y < top + h;
  };

  it('puts its top-left at the hotspot x, just below the arrow', () => {
    const p = placeAtPointer({ pointer: { x: 300, y: 200 }, area: desk, width: 240, height: 40 });
    expect([p.side, p.left, p.top]).toEqual(['below', 300, 220]);
    expect(p.maxHeight).toBe(792 - 220);
  });

  it('goes left of the pointer at the right edge, above it at the bottom edge', () => {
    const right = placeAtPointer({ pointer: { x: 1200, y: 200 }, area: desk, width: 240 });
    expect(right.left).toBe(1200 - 240);
    const low = placeAtPointer({ pointer: { x: 300, y: 770 }, area: desk, width: 240, height: 60 });
    expect([low.side, low.bottom]).toEqual(['above', 800 - 762]);
  });

  it('clamps inside the edges when neither side fits, and caps the larger side', () => {
    const phone = placeAtPointer({ pointer: { x: 200, y: 300 }, area, width: Infinity });
    expect([phone.left, phone.width]).toEqual([8, 374]);
    const tall = placeAtPointer({
      pointer: { x: 300, y: 500 },
      area: desk,
      width: 200,
      height: 2000,
    });
    expect([tall.side, tall.maxHeight]).toEqual(['above', 492 - 8]);
  });

  it('never sits under the pointer, anywhere on the screen', () => {
    for (const x of [8, 300, 1100, 1257])
      for (const y of [8, 400, 760, 792])
        for (const h of [24, 120]) {
          const p = placeAtPointer({ pointer: { x, y }, area: desk, width: 240, height: h });
          const shown = Math.min(h, p.maxHeight);
          expect(underPointer(p, x, y, shown), `${x},${y} h${h}`).toBe(false);
          expect(p.left).toBeGreaterThanOrEqual(8);
          expect(p.left + p.width).toBeLessThanOrEqual(1265 - 8);
        }
  });
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

  it('keeps a hover popup clear of the pointer below its trigger, and only below', () => {
    const below = placeAnchored({ trigger: rect(44), area, width: 200, height: 100, hover: true });
    // The pointer's hotspot is inside the trigger (bottom 80); its drawing ends 22px under it.
    expect(below.top).toBe(80 + POINTER_CLEARANCE);
    const above = placeAnchored({ trigger: rect(600), area, width: 200, height: 300, hover: true });
    expect(above.side).toBe('above');
    expect(above.bottom).toBe(772 - 596);
    const desktop = placeAnchored({
      trigger: rect(44),
      area,
      width: 200,
      hover: true,
      desktop: true,
    });
    expect(desktop.top).toBe(80 + POINTER_CLEARANCE);
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
    const docked = { ...area, top: 124, bottom: 772 - 52 - 8, reach: 772 };
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
      desktop: true,
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

  it('keeps the old desktop path near the bottom: below, at least 160 tall, no flip', () => {
    const desktop = { top: 8, bottom: 792, width: 1280, layoutHeight: 800, edge: 8 };
    const placed = placeAnchored({
      trigger: { top: 600, bottom: 636, left: 900, right: 980 },
      area: desktop,
      width: 560,
      height: 300,
      desktop: true,
    });
    expect(placed).toMatchObject({ side: 'below', top: 640, bottom: 'auto', maxHeight: 160 });
  });

  it('clamps a trigger under the keyboard: the popover stays in the visible area', () => {
    const keyboard = { ...area, bottom: 420 };
    const placed = placeAnchored({
      trigger: rect(600),
      area: keyboard,
      width: Infinity,
      height: 200,
    });
    expect(placed.side).toBe('above');
    // Its bottom edge sits on the visible bottom, not behind the keyboard.
    expect(772 - (placed.bottom as number)).toBe(420);
    expect(placed.maxHeight).toBe(420 - 8);
  });

  it('clamps a trigger scrolled off the top', () => {
    const placed = placeAnchored({ trigger: rect(-100), area, width: Infinity, height: 200 });
    expect(placed).toMatchObject({ side: 'below', top: 8, maxHeight: 764 - 8 });
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

describe('placeAnchored with the real visible area', () => {
  const phoneWindow = (height: number, dock: number) =>
    ({
      innerWidth: 390,
      innerHeight: 772,
      visualViewport: { offsetTop: 0, height },
      matchMedia: () => ({ matches: true }),
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => `${dock}px`, fontSize: '16px' }),
    }) as unknown as Window;

  it('keeps a popover off the docked bar when its trigger is under the keyboard', () => {
    const area = visibleArea(phoneWindow(480, 52));
    const placed = placeAnchored({ trigger: rect(600), area, width: Infinity, height: 200 });
    // The bar covers 428-480: the popover's bottom edge stays above it.
    expect(772 - (placed.bottom as number)).toBeLessThanOrEqual(480 - 52);
  });

  it('still stands flush on a trigger that is on the docked bar', () => {
    const area = visibleArea(phoneWindow(480, 52));
    const placed = placeAnchored({ trigger: rect(437, 43), area, width: Infinity, gap: 0 });
    expect(placed).toMatchObject({ side: 'above', bottom: 772 - 437 });
  });
});

describe('the scrollbar gutter', () => {
  // global.scss reserves `scrollbar-gutter: stable` on the root: with a classic 15px scrollbar the
  // root box is 375 wide in a 390 window, and clientWidth may still report 390.
  const gutterWindow = (
    root: { clientWidth?: number; offsetWidth?: number },
    phone = true,
    innerWidth = 390,
  ) =>
    ({
      innerWidth,
      innerHeight: 772,
      visualViewport: { offsetTop: 0, height: 772 },
      matchMedia: () => ({ matches: phone }),
      document: { documentElement: root },
      getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '16px' }),
    }) as unknown as Window;

  it('uses the root box width, not the window width that counts the gutter', () => {
    expect(viewportWidth(gutterWindow({ clientWidth: 390, offsetWidth: 375 }))).toBe(375);
    expect(viewportWidth(gutterWindow({ clientWidth: 375, offsetWidth: 375 }))).toBe(375);
  });

  it('falls back to the window width when the root has no layout', () => {
    expect(viewportWidth(gutterWindow({}))).toBe(390);
    expect(viewportWidth(gutterWindow({ clientWidth: 0, offsetWidth: 0 }))).toBe(390);
  });

  it('keeps a full-width popover its edge inset left of the gutter', () => {
    const area = visibleArea(gutterWindow({ clientWidth: 390, offsetWidth: 375 }));
    const placed = placeAnchored({ trigger: rect(100), area, width: Infinity });
    expect(placed.left).toBe(area.edge);
    expect(placed.left + placed.width).toBe(375 - area.edge);
  });

  it('clamps a right-aligned desktop popover left of the gutter', () => {
    const area = visibleArea(gutterWindow({ clientWidth: 1280, offsetWidth: 1265 }, false, 1280));
    const placed = placeAnchored({
      trigger: { top: 0, bottom: 40, left: 1240, right: 1300 },
      area,
      width: 560,
      desktop: true,
    });
    expect(placed.left + placed.width).toBe(1265 - 8);
  });
});
