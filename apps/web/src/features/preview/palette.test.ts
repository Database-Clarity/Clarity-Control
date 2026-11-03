import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The preview's colours are tokens per theme (dark is the in-game look, light is its own palette).
// Every text colour must hold 4.5:1 on the surface of its own theme.
const css = readFileSync('apps/web/src/features/preview/TooltipPreview.module.scss', 'utf8');

function block(name: string): Record<string, string> {
  const match = new RegExp(`@mixin ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!match) throw new Error(`no ${name}`);
  return Object.fromEntries(
    [...match[1].matchAll(/--tp-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

function rgb(value: string): [number, number, number] {
  if (value === 'black') return [0, 0, 0];
  if (value === 'white' || value === '#fff') return [255, 255, 255];
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex)
    return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const hsl = /^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)$/.exec(value);
  if (!hsl) throw new Error(`unsupported colour ${value}`);
  const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
function luminance(color: string) {
  const [r, g, b] = rgb(color).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const onSurface = [
  'text',
  'pvp',
  'pve',
  'green',
  'yellow',
  'blue',
  'purple',
  'arrow',
  'title',
  'link',
];

describe('tooltip preview palette', () => {
  for (const mixin of ['dark-values', 'light-values']) {
    const tokens = block(mixin);
    it(`${mixin}: text colours hold 4.5:1 on the surface`, () => {
      for (const name of onSurface)
        expect(contrast(tokens[name], tokens.surface), name).toBeGreaterThanOrEqual(4.5);
    });
    it(`${mixin}: header, nested link and pop-up text hold 4.5:1 on their backgrounds`, () => {
      expect(contrast(tokens['head-text'], tokens['head-bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['assoc-link'], tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['pop-text'], tokens['pop-bg'])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('is a separate light palette, not the dark one inverted', () => {
    const dark = block('dark-values');
    const light = block('light-values');
    expect(luminance(light.surface)).toBeGreaterThan(0.9);
    expect(luminance(dark.surface)).toBeLessThan(0.05);
    // Each colour keeps its hue family: red stays red, blue stays blue.
    const [pr, , pb] = rgb(light.pvp);
    expect(pr).toBeGreaterThan(pb * 2);
    const [vr, , vb] = rgb(light.pve);
    expect(vb).toBeGreaterThan(vr * 2);
  });
});
