import { uiScaleEvent } from './useMedia';

// The root font size in CSS pixels, read once and kept until the interface scale changes. Reading
// it is a computed-style read of the root, and with container queries on the page that forces a
// full style and layout pass: a view that mounts and asks for it would lay the page out early and
// then again once it has rendered. Everything that sets the root font size announces it with the
// interface-scale event, which drops the kept value before any other listener reads it.
let rootPx: number | undefined;
if (typeof window !== 'undefined')
  window.addEventListener(uiScaleEvent, () => {
    rootPx = undefined;
  });

/**
 * Design pixels as the interface is scaled now: the root font size is the Interface scale
 * setting (and the browser's default font size), so a 480px popover at 150% is 720 CSS pixels.
 * Anything positioned in JavaScript from a fixed pixel width goes through this.
 */
export function scaledPx(designPx: number): number {
  if (typeof document === 'undefined') return designPx;
  if (rootPx === undefined) {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    rootPx = Number.isFinite(root) && root > 0 ? root : 16;
  }
  return (designPx * rootPx) / 16;
}
