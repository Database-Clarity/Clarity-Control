import { describe, expect, test } from 'vitest';
import { canReplaceGlyph, glyphWarnings } from './glyphs.js';
import { glyphPolicy } from './glyph-policy.js';
import { validateText } from './index.js';

describe('portable glyph warnings', () => {
  test('replacement cannot introduce a closing delimiter inside a tag', () => {
    for (const text of ['<title Damage 🠚 [Details] />', '<class 🠚>']) {
      expect(canReplaceGlyph(text, glyphWarnings(text)[0])).toBe(false);
    }
    const text = '<b>Damage 🠚 higher</b>';
    expect(canReplaceGlyph(text, glyphWarnings(text)[0])).toBe(true);
  });
  test('all printable ASCII and ordinary controls are accepted', () => {
    expect(
      glyphWarnings(
        Array.from({ length: 95 }, (_, i) => String.fromCodePoint(32 + i)).join('') + '\t\r\n',
      ),
    ).toEqual([]);
  });
  test('existing common punctuation, layout controls and letters are accepted', () => {
    expect(glyphWarnings('• 20° × 2 – — … “ö” ⇒ ♥\u00a0\u2060')).toEqual([]);
    expect(glyphWarnings('Café déjà vu naïve Straße português')).toEqual([]);
  });
  test('reports each occurrence at UTF-16 offsets, including astral symbols and combining marks', () => {
    const warnings = glyphWarnings('a🠚🠚x\u0301\uE000😀');
    expect(warnings.map((w) => [w.codePoint, w.from, w.to])).toEqual([
      ['U+1F81A', 1, 3],
      ['U+1F81A', 3, 5],
      ['U+0301', 6, 7],
      ['U+E000', 7, 8],
      ['U+1F600', 8, 10],
    ]);
    expect(warnings[0].replacement).toBe('->');
    expect(warnings[4].replacement).toBeUndefined();
  });
  test('no blind replacement for semantic enhanced markers or invisible text', () => {
    expect(glyphWarnings('🡅\uFEFF').map((w) => w.replacement)).toEqual([undefined, undefined]);
    expect(glyphWarnings('\uFEFF')[0].message).toContain('(invisible) U+FEFF');
    expect(glyphWarnings('▛▟').every((w) => w.reason.includes('unverified'))).toBe(true);
  });
  test('curated replacements are themselves portable', () => {
    for (const known of Object.values(glyphPolicy.knownRisk)) {
      if (known.replacement !== undefined) expect(glyphWarnings(known.replacement)).toEqual([]);
    }
  });
  test('shared save validation warns without blocking', () => {
    const issues = validateText('Value 🠚 next', 'en');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', from: 6, to: 8 });
    expect(issues[0].message).toContain('U+1F81A');
  });
  test('long ASCII descriptions and repeated calls are stable', () => {
    const text = 'A normal tooltip line.\n'.repeat(10000) + '🠚';
    expect(glyphWarnings(text)).toHaveLength(1);
    expect(glyphWarnings(text)[0].from).toBe(text.length - 2);
    expect(glyphWarnings('safe')).toEqual([]);
  });
});
