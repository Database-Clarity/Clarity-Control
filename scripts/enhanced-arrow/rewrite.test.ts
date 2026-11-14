import { describe, expect, test } from 'vitest';
import { lowerConsumerMarkup } from '../../packages/core/src/index.js';
import { census, rewriteLegacyArrow } from './rewrite';

describe('rewriteLegacyArrow', () => {
  test('turns the arrow #e into <enhanced/> and nothing else', () => {
    const text =
      'Base.\nenhanced (\nvar d = 1\n#e Faster.\n)\nLasts #e${5+#d} s; #element and #e2 stay. {{a}{#e b}}';
    const result = rewriteLegacyArrow(text);
    expect(result.text).toBe(
      'Base.\nenhanced (\nvar d = 1\n<enhanced/> Faster.\n)\nLasts <enhanced/>${5+#d} s; #element and #e2 stay. {{a}{<enhanced/> b}}',
    );
    expect(result.rewritten).toHaveLength(3);
    expect(lowerConsumerMarkup(result.text)).toBe(text);
  });
  test('leaves comments, URLs, link targets, and words alone, with the reason', () => {
    const text = [
      '// #e is the arrow',
      '/* old #e */ kept',
      'See https://example.com/page#e for more.',
      '<link wiki [https://x.test/#e] />',
      'abc#e and #e',
    ].join('\n');
    const result = rewriteLegacyArrow(text);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      'comment',
      'comment',
      'url',
      'url',
      'word',
    ]);
    expect(result.text).toBe(text.replace(/and #e$/, 'and <enhanced/>'));
  });
  test('text without a rewritable arrow is returned as the same string', () => {
    for (const text of ['', 'No arrow.', '#element #e1', '// #e']) {
      expect(rewriteLegacyArrow(text).text).toBe(text);
    }
  });
});

describe('census', () => {
  test('counts arrows per language and category, longer names, merges, and local e', () => {
    const result = census([
      {
        hash: 10,
        lang: 'en',
        category: 'weapon-trait',
        text: '#e A\n#e B #e',
        globals: 'var e = x',
      },
      {
        hash: 11,
        lang: 'en',
        category: 'weapon-trait',
        text: 'var d = 1\n#dx #element',
        globals: 'var e = x',
      },
      { hash: 12, lang: 'de', category: 'armor', text: 'var e = y\n#e', globals: '' },
    ]);
    expect(result.arrows).toEqual({
      en: { 'weapon-trait': { texts: 1, lines: 2, uses: 3 } },
      de: { armor: { texts: 1, lines: 1, uses: 1 } },
    });
    expect(result.longerNames).toEqual({ '#element': 1 });
    expect(result.merged.map((row) => [row.reference, row.variable])).toEqual([
      ['#dx', 'd'],
      ['#element', 'e'],
    ]);
    expect(result.localArrowDefinitions).toEqual([{ hash: 12, lang: 'de' }]);
  });
});
