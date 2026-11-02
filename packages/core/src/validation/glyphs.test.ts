import { describe, expect, test } from 'vitest';
import { canReplaceGlyph, glyphWarnings } from './glyphs.js';
import { glyphPolicy } from './glyph-policy.js';
import { validateText } from './index.js';
import { languages, type Lang } from '../languages.js';

const languageSamples: Record<Lang, string> = {
  en: 'Damage increased by 20%.',
  de: 'Schaden erhöht: größer, Fuß.',
  es: 'Daño aumentado. ¿Cuánto?',
  'es-mx': 'Daño aumentado. ¡Más poder!',
  fr: 'Dégâts augmentés de 20 %.',
  it: 'Danni aumentati. Più abilità.',
  ja: 'ダメージが増加。攻撃力２０％「強化」',
  ko: '피해가 증가합니다. 강화 능력',
  pl: 'Obrażenia zwiększone. Żółć, łąka.',
  'pt-br': 'Dano aumentado. Ação e duração.',
  ru: 'Урон увеличен. Ёмкость № 2.',
  'zh-chs': '伤害提高。攻击力增加２０％',
  'zh-cht': '傷害提高。攻擊力增加２０％',
};

describe('portable glyph warnings', () => {
  test.each(languages)('ordinary %s source and decomposed text has no glyph warnings', (lang) => {
    for (const text of [languageSamples[lang], languageSamples[lang].normalize('NFD')]) {
      expect(validateText(text, lang)).toEqual([]);
      expect(glyphWarnings(text)).toEqual([]);
      expect(glyphWarnings(`${text} 🠚`)).toEqual([
        expect.objectContaining({ codePoint: 'U+1F81A', from: text.length + 1 }),
      ]);
    }
  });
  test('unvetted supplementary Han and specialist symbols still warn', () => {
    expect(glyphWarnings('𠮷🠚🡅\uE000😀').map((w) => w.codePoint)).toEqual([
      'U+20BB7',
      'U+1F81A',
      'U+1F845',
      'U+E000',
      'U+1F600',
    ]);
  });
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
  test('reports each occurrence at UTF-16 offsets, including astral symbols and private-use text', () => {
    const warnings = glyphWarnings('a🠚🠚x\uE000😀');
    expect(warnings.map((w) => [w.codePoint, w.from, w.to])).toEqual([
      ['U+1F81A', 1, 3],
      ['U+1F81A', 3, 5],
      ['U+E000', 6, 7],
      ['U+1F600', 7, 9],
    ]);
    expect(warnings[0].replacement).toBe('->');
    expect(warnings[3].replacement).toBeUndefined();
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
