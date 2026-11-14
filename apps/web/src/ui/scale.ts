/**
 * Design pixels as the interface is scaled now: the root font size is the Interface scale
 * setting (and the browser's default font size), so a 480px popover at 150% is 720 CSS pixels.
 * Anything positioned in JavaScript from a fixed pixel width goes through this.
 */
export function scaledPx(designPx: number): number {
  if (typeof document === 'undefined') return designPx;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(root) && root > 0 ? (designPx * root) / 16 : designPx;
}
