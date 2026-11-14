// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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
  it('opens flush below its anchor, aligned to its left edge', () => {
    const { anchor, popover } = setup(rect(100, 100, 60, 16), { width: 200, height: 80 });
    openTitlePopover(anchor, popover);
    expect([popover.style.left, popover.style.top]).toEqual(['100px', '116px']);
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
    expect(popover.style.top).toBe('370px');
  });

  it('limits the height, scrolling, when neither side fits', () => {
    const { anchor, popover } = setup(rect(100, 300, 60, 16), { width: 200, height: 900 });
    openTitlePopover(anchor, popover);
    // 600 - 316 - 8 below, 300 - 8 above: above is larger, so it goes up with that much room.
    expect(popover.style.maxHeight).toBe('292px');
  });

  it('uses the wrapped line the pointer is on', () => {
    const { anchor, popover } = setup(rect(10, 100, 60, 16), { width: 120, height: 40 });
    anchor.getClientRects = () =>
      [rect(500, 100, 200, 16), rect(10, 120, 80, 16)] as unknown as DOMRectList;
    openTitlePopover(anchor, popover, { x: 30, y: 128 });
    expect([popover.style.left, popover.style.top]).toEqual(['10px', '136px']);
  });
});
