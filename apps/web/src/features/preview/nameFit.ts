/**
 * The perk header's name is one line: its font shrinks to fit the column down to a floor, then
 * ellipsises (the full name is the element's title). The size is a CSS calculation over the name's
 * width in ems, so stepping never measures the DOM: text is measured once per name on a canvas,
 * which does not touch layout.
 */

/** Today's size of the name, and the smallest size it shrinks to (75%) before it ellipsises. */
export const nameSizeRem = 1.3125;
export const nameFloorRem = nameSizeRem * 0.75;

// Arial semi-bold, uppercase, as the header sets it (.name in TooltipPreview.module.scss); the
// header's letter-spacing is -0.02em per character.
const font = 'bold 100px Arial, Helvetica, sans-serif';
const spacingEm = -0.02;
/** When there is no canvas (tests, very old browsers): a typical uppercase Arial glyph. */
const averageEm = 0.7;

const cache = new Map<string, number>();
let measure: ((text: string) => number) | null | undefined;

function canvasMeasure(): ((text: string) => number) | null {
  if (measure !== undefined) return measure;
  measure = null;
  // jsdom has no canvas and reports every attempt, so do not try there.
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return measure;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return measure;
  context.font = font;
  measure = (text) => context.measureText(text).width / 100;
  return measure;
}

/** The name's width in ems at the header's font, uppercased and letter-spaced. */
export function nameWidthEm(name: string): number {
  let width = cache.get(name);
  if (width === undefined) {
    const text = name.toUpperCase();
    const measured = canvasMeasure()?.(text) ?? text.length * averageEm;
    width = measured + text.length * spacingEm;
    if (cache.size > 2000) cache.clear();
    cache.set(name, width);
  }
  return width;
}
