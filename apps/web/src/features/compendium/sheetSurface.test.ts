import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readableOn, sheetSurfaceColors, sheetTextColor } from './sheetSurface';

const tokens = readFileSync(new URL('../../ui/tokens.scss', import.meta.url), 'utf8');
const sheetBg = [...tokens.matchAll(/--sheet-bg:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
const sheetText = [...tokens.matchAll(/--sheet-text:\s*(#[0-9a-f]{3,6})/gi)].map((m) => m[1]);
const red = (hex: string) => parseInt(hex.slice(1, 3), 16);

describe('Compendium editor surface', () => {
  it('keeps the TypeScript colours in step with the dark and light tokens', () => {
    expect(sheetBg).toEqual([sheetSurfaceColors.dark, sheetSurfaceColors.light]);
    expect(sheetText).toHaveLength(2);
    for (const text of sheetText)
      expect(text.toLowerCase().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3')).toBe(sheetTextColor);
  });

  it('raises the light theme cell a little, and the default text is AA on both', () => {
    expect(red(sheetSurfaceColors.light)).toBeGreaterThan(red(sheetSurfaceColors.dark));
    expect(contrastRatio(sheetTextColor, sheetSurfaceColors.dark)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(sheetTextColor, sheetSurfaceColors.light)).toBeGreaterThanOrEqual(4.5);
  });

  it('readableOn leaves AA colours alone and lifts the rest to AA, keeping them coloured', () => {
    const bg = sheetSurfaceColors.light;
    expect(readableOn('#89cdd1', bg)).toBe('#89cdd1');
    for (const dark of ['#783f04', '#3c78d8', '#2c3436', '#e06666', '#a481e1']) {
      const lifted = readableOn(dark, bg);
      expect(contrastRatio(lifted, bg)).toBeGreaterThanOrEqual(4.5);
      expect(lifted).not.toBe(dark);
    }
    // The brown stays warm (red above blue) instead of washing out to grey.
    const brown = readableOn('#783f04', bg);
    expect(red(brown)).toBeGreaterThan(parseInt(brown.slice(5, 7), 16));
  });

  it('goes toward black on a light sheet background', () => {
    const lifted = readableOn('#cccccc', '#efeded');
    expect(contrastRatio(lifted, '#efeded')).toBeGreaterThanOrEqual(4.5);
    expect(red(lifted)).toBeLessThan(0xcc);
  });
});
