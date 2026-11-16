// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { POINTER_CLEARANCE } from '../../ui/anchorPlacement';
import { closeTitlePopover, openTitlePopover } from './titlePopover';

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

function setup(
  anchorRect: DOMRect,
  box: { width: number; height: number },
  view = { w: 800, h: 600 },
) {
  const anchor = document.createElement('span');
  const popover = document.createElement('span');
  anchor.append(popover);
  document.body.append(anchor);
  anchor.getClientRects = () => [anchorRect] as unknown as DOMRectList;
  Object.defineProperty(popover, 'offsetWidth', { value: box.width, configurable: true });
  Object.defineProperty(popover, 'offsetHeight', { value: box.height, configurable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: view.w,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: view.h,
    configurable: true,
  });
  return { anchor, popover };
}
afterEach(() => (document.body.innerHTML = ''));

describe('title popover placement', () => {
  it('opens below its anchor, clear of the pointer, aligned to its left edge', () => {
    const { anchor, popover } = setup(rect(100, 100, 60, 16), { width: 200, height: 80 });
    openTitlePopover(anchor, popover);
    expect([popover.style.left, popover.style.top]).toEqual(['100px', '138px']);
    expect(popover.hasAttribute('data-open')).toBe(true);
    closeTitlePopover(popover);
    expect(popover.hasAttribute('data-open')).toBe(false);
  });

  it('shifts left to stay inside the viewport', () => {
    const { anchor, popover } = setup(rect(740, 100, 50, 16), { width: 300, height: 80 });
    openTitlePopover(anchor, popover);
    expect(popover.style.left).toBe('492px');
  });

  it('keeps its edge inset left of the reserved scrollbar gutter', () => {
    const { anchor, popover } = setup(rect(740, 100, 50, 16), { width: 300, height: 80 });
    // A classic 15px scrollbar: clientWidth can count the gutter, the root's own box does not.
    Object.defineProperty(document.documentElement, 'offsetWidth', {
      value: 785,
      configurable: true,
    });
    try {
      openTitlePopover(anchor, popover);
      expect(popover.style.left).toBe('477px');
      expect(popover.style.maxWidth).toBe('min(18.75rem, 769px)');
    } finally {
      delete (document.documentElement as { offsetWidth?: number }).offsetWidth;
    }
  });

  it('flips above when below is too short and above has more room', () => {
    const { anchor, popover } = setup(rect(100, 520, 60, 16), { width: 200, height: 150 });
    openTitlePopover(anchor, popover);
    expect(popover.style.top).toBe('366px');
  });

  it('limits the height, scrolling, when neither side fits', () => {
    const { anchor, popover } = setup(rect(100, 300, 60, 16), { width: 200, height: 900 });
    openTitlePopover(anchor, popover);
    // 600 - 316 - 22 - 8 below, 300 - 4 - 8 above: above is larger, so it goes up with that much room.
    expect(popover.style.maxHeight).toBe('288px');
  });

  it('uses the wrapped line the pointer is on', () => {
    const { anchor, popover } = setup(rect(10, 100, 60, 16), { width: 120, height: 40 });
    anchor.getClientRects = () =>
      [rect(500, 100, 200, 16), rect(10, 120, 80, 16)] as unknown as DOMRectList;
    openTitlePopover(anchor, popover, { x: 30, y: 128 });
    expect([popover.style.left, popover.style.top]).toEqual(['10px', '158px']);
  });
});

describe('title popover pointer clearance', () => {
  // The drawn pointer: down and right of its hotspot, at most POINTER_CLEARANCE tall.
  const covers = (box: DOMRect, x: number, y: number) =>
    x + 16 > box.left && x - 6 < box.right && y + POINTER_CLEARANCE > box.top && y < box.bottom;
  const placed = (popover: HTMLElement, width: number, height: number) =>
    new DOMRect(parseFloat(popover.style.left), parseFloat(popover.style.top), width, height);

  it('never sits under the pointer or its trigger, below, flipped above, or at the edges', () => {
    const cases = [
      rect(100, 100, 12, 12), // a finder marker glyph
      rect(400, 300, 120, 16), // a term in running text
      rect(780, 100, 12, 12), // at the right edge: shifted left
      rect(100, 560, 12, 12), // at the bottom edge: flipped above
      rect(780, 560, 12, 12), // the bottom-right corner
    ];
    for (const trigger of cases) {
      const { anchor, popover } = setup(trigger, { width: 240, height: 48 });
      for (const fx of [0, 0.5, 1])
        for (const fy of [0, 0.5, 1]) {
          const x = trigger.left + trigger.width * fx;
          const y = trigger.top + trigger.height * fy;
          openTitlePopover(anchor, popover, { x, y });
          const box = placed(popover, 240, 48);
          expect(covers(box, x, y), `${trigger.left},${trigger.top} @ ${x},${y}`).toBe(false);
          expect(box.top >= trigger.bottom || box.bottom <= trigger.top).toBe(true);
        }
      document.body.innerHTML = '';
    }
  });

  it('opens in the same place from keyboard focus as from hover', () => {
    const { anchor, popover } = setup(rect(100, 100, 12, 12), { width: 200, height: 40 });
    openTitlePopover(anchor, popover, { x: 106, y: 111 });
    const hovered = [popover.style.left, popover.style.top];
    openTitlePopover(anchor, popover);
    expect([popover.style.left, popover.style.top]).toEqual(hovered);
  });

  it('keeps the plain gap on a phone, where nothing hovers', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: true, media: query })) as typeof matchMedia;
    try {
      const { anchor, popover } = setup(rect(100, 100, 60, 16), { width: 200, height: 80 });
      openTitlePopover(anchor, popover);
      expect(popover.style.top).toBe('120px');
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('shows one at a time: the next box closes one still in its close grace', () => {
    const first = setup(rect(100, 100, 12, 12), { width: 200, height: 40 });
    const second = setup(rect(100, 130, 12, 12), { width: 200, height: 40 });
    openTitlePopover(first.anchor, first.popover);
    openTitlePopover(second.anchor, second.popover);
    expect(first.popover.hasAttribute('data-open')).toBe(false);
    expect(second.popover.hasAttribute('data-open')).toBe(true);
  });
});
