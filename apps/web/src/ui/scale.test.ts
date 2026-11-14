// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { scaledPx } from './scale';
import { uiScaleEvent } from './useMedia';

afterEach(() => {
  vi.restoreAllMocks();
  window.dispatchEvent(new Event(uiScaleEvent));
});

it('reads the root font size once, until an interface scale change is announced', () => {
  let rootPx = 24;
  const read = vi
    .spyOn(window, 'getComputedStyle')
    .mockImplementation(() => ({ fontSize: `${rootPx}px` }) as CSSStyleDeclaration);
  window.dispatchEvent(new Event(uiScaleEvent));
  expect(scaledPx(480)).toBe(720);
  // A view mounting later asks again: no style read (it would lay the page out early).
  expect(scaledPx(16)).toBe(24);
  expect(read).toHaveBeenCalledTimes(1);
  rootPx = 20;
  window.dispatchEvent(new Event(uiScaleEvent));
  expect(scaledPx(16)).toBe(20);
  expect(read).toHaveBeenCalledTimes(2);
});
