// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { POINTER_CLEARANCE, POINTER_OFFSET } from '../../ui/anchorPlacement';
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
  it('opens below-right of its anchor, clear of the pointer', () => {
    const { anchor, popover } = setup(rect(100, 100, 60, 16), { width: 200, height: 80 });
    openTitlePopover(anchor, popover);
    expect([popover.style.left, popover.style.top]).toEqual(['160px', '138px']);
    expect(popover.hasAttribute('data-open')).toBe(true);
    closeTitlePopover(popover);
    expect(popover.hasAttribute('data-open')).toBe(false);
  });

  it('flips to below-left of its anchor at the right edge', () => {
    const { anchor, popover } = setup(rect(740, 100, 50, 16), { width: 300, height: 80 });
    openTitlePopover(anchor, popover);
    expect(popover.style.left).toBe('440px');
  });

  it('clamps inside the edge inset, left of the scrollbar gutter, when neither side fits', () => {
    const { anchor, popover } = setup(rect(500, 100, 50, 16), { width: 600, height: 80 });
    // A classic 15px scrollbar: clientWidth can count the gutter, the root's own box does not.
    Object.defineProperty(document.documentElement, 'offsetWidth', {
      value: 785,
      configurable: true,
    });
    try {
      openTitlePopover(anchor, popover);
      expect(popover.style.left).toBe('177px');
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
});

describe('title popover at the pointer', () => {
  // The drawn pointer: down and right of its hotspot, POINTER_OFFSET.y tall.
  const covers = (box: DOMRect, x: number, y: number) =>
    x + 12 > box.left && x < box.right && y + POINTER_OFFSET.y > box.top && y < box.bottom;
  const placed = (popover: HTMLElement, width: number, height: number) =>
    new DOMRect(parseFloat(popover.style.left), parseFloat(popover.style.top), width, height);

  it('opens just below-right of the pointer, wherever it is on the anchor', () => {
    // The owner's case: a 28px tall greyed Compare tab, the pointer on its upper half.
    const { anchor, popover } = setup(rect(300, 40, 80, 28), { width: 220, height: 30 });
    openTitlePopover(anchor, popover, { x: 330, y: 48 });
    expect([popover.style.left, popover.style.top]).toEqual(['334px', '72px']);
  });

  it('goes left of the pointer at the right edge, above it at the bottom edge', () => {
    const { anchor, popover } = setup(rect(700, 560, 90, 16), { width: 200, height: 60 });
    openTitlePopover(anchor, popover, { x: 760, y: 568 });
    // 760 - 4 - 200 = 556 left; bottom 8px over the hotspot: 568 - 8 - 60 = 500 top.
    expect([popover.style.left, popover.style.top]).toEqual(['556px', '500px']);
  });

  it('never sits under the pointer, below, flipped above, or at the edges', () => {
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
          closeTitlePopover(popover);
          openTitlePopover(anchor, popover, { x, y });
          const box = placed(popover, 240, 48);
          expect(covers(box, x, y), `${trigger.left},${trigger.top} @ ${x},${y}`).toBe(false);
          expect(box.left >= 8 && box.right <= 792 && box.top >= 8 && box.bottom <= 592).toBe(true);
        }
      document.body.innerHTML = '';
    }
  });

  it('keeps the anchor placement for keyboard focus (no pointer)', () => {
    const { anchor, popover } = setup(rect(100, 100, 12, 12), { width: 200, height: 40 });
    openTitlePopover(anchor, popover);
    expect([popover.style.left, popover.style.top]).toEqual([
      '112px',
      `${112 + POINTER_CLEARANCE}px`,
    ]);
  });

  it('shows one at a time: the next box closes one still in its close grace', () => {
    const first = setup(rect(100, 100, 12, 12), { width: 200, height: 40 });
    const second = setup(rect(100, 130, 12, 12), { width: 200, height: 40 });
    openTitlePopover(first.anchor, first.popover);
    openTitlePopover(second.anchor, second.popover);
    expect(first.popover.hasAttribute('data-open')).toBe(false);
    expect(second.popover.hasAttribute('data-open')).toBe(true);
  });

  it('lets the pointer through a plain box, so an anchor under it still gets its hover', () => {
    const plain = setup(rect(100, 100, 12, 12), { width: 200, height: 40 });
    openTitlePopover(plain.anchor, plain.popover);
    expect(plain.popover.style.pointerEvents).toBe('none');
    // A link to click, or a body to scroll, keeps the box reachable across its gap.
    const linked = setup(rect(100, 130, 12, 12), { width: 200, height: 40 });
    linked.popover.innerHTML = '<a href="https://example.com">More</a>';
    openTitlePopover(linked.anchor, linked.popover);
    expect(linked.popover.style.pointerEvents).toBe('');
    const tall = setup(rect(100, 300, 12, 12), { width: 200, height: 40 });
    Object.defineProperty(tall.popover, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(tall.popover, 'clientHeight', { value: 200, configurable: true });
    openTitlePopover(tall.anchor, tall.popover);
    expect(tall.popover.style.pointerEvents).toBe('');
  });
});
