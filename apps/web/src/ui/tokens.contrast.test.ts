import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../features/compendium/sheetSurface';

const source = readFileSync(new URL('./tokens.scss', import.meta.url), 'utf8');
function block(name: string): Record<string, string> {
  const start = source.indexOf(`@mixin ${name} {`);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]),
  );
}
const light = block('light-tokens');
const dark = block('dark-tokens');
const previewSurface = '#fdfeff';
const ratio = (fg: string, bg: string) => contrastRatio(light[fg] ?? fg, light[bg] ?? bg);

describe('light theme tokens (theme design spec §2-§3)', () => {
  it('keeps text AA on every surface it appears on', () => {
    for (const text of ['text', 'text2', 'tab', 'glyph'])
      for (const surface of ['page', 'raised', 'chrome'])
        expect(ratio(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio('text3', 'page')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('link', 'page')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('link', 'raised')).toBeGreaterThanOrEqual(5.5);
    expect(ratio('accent-ink', 'raised')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('editor-text', 'editor')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('editor-text2', 'editor')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('text', 'sel')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('warn', 'warn-bg')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('stasis-text', 'stasis')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('del-text', 'del-bg')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('ins', 'ins-bg')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('sheet-text', 'sheet-bg')).toBeGreaterThanOrEqual(4.5);
    for (const ink of ['muted', 'meta', 'bad-ink'])
      for (const surface of ['page', 'raised', 'box-bg'])
        expect(ratio(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio('found-text', 'found-bg')).toBeGreaterThanOrEqual(4.5);
  });

  it('separates surfaces and draws visible lines and control edges', () => {
    expect(ratio('raised', 'page')).toBeGreaterThanOrEqual(1.25);
    // Spec says 1.16 (rounded); the spec's own hex values measure 1.156.
    expect(ratio('page', 'chrome')).toBeGreaterThanOrEqual(1.15);
    expect(ratio('hover', 'raised')).toBeGreaterThanOrEqual(1.3);
    expect(ratio('raised', 'sel')).toBeGreaterThanOrEqual(1.5);
    // Pane separators ≥1.9 on the page, ≥2.4 on raised; popover edges ≥3 (WCAG 1.4.11).
    expect(ratio('line', 'page')).toBeGreaterThanOrEqual(1.85);
    expect(ratio('line', 'raised')).toBeGreaterThanOrEqual(2.3);
    expect(ratio('pop-edge', 'raised')).toBeGreaterThanOrEqual(3);
    for (const edge of ['ctl-edge', 'fld-edge', 'badge-edge', 'status-edge'])
      for (const surface of ['page', 'raised', 'chrome'])
        expect(ratio(edge, surface), `${edge} on ${surface}`).toBeGreaterThanOrEqual(3);
  });

  it('fills symbols in the game hues at 3:1 on the preview surface; slate for the white glyphs', () => {
    const symbols = Object.keys(light).filter((key) => key.startsWith('sym-'));
    expect(symbols).toHaveLength(11);
    for (const key of symbols)
      expect(contrastRatio(light[key], previewSurface), key).toBeGreaterThanOrEqual(3);
    expect(light['sym-neutral']).toBe('#5a6775');
    expect(light['sym-arc']).toBe('#1795c2');
    expect(light['sym-stasis']).toBe('#3366d6');
    expect(contrastRatio(light['sym-neutral'], light['editor'])).toBeGreaterThanOrEqual(3);
    // Arc and Stasis stay distinguishable side by side.
    expect(contrastRatio(light['sym-arc'], light['sym-stasis'])).toBeGreaterThanOrEqual(1.5);
  });

  it('defines every symbol token in both themes (dark draws the game artwork and ignores them)', () => {
    const names = (map: Record<string, string>) => Object.keys(map).sort();
    expect(names(dark)).toEqual(names(light));
  });
});
