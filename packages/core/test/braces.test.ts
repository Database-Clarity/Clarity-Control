import { descriptionConverter, type IntermediatePerk } from '@icemourne/description-converter';
import { describe, expect, test } from 'vitest';
import {
  holderName,
  isHolderName,
  isMarkupOnly,
  lowerConsumerMarkup,
  lowerDelimitedMarkup,
  mergedVariable,
  variableReferences,
} from '../src/markup/braces.js';
import { parseMarkup } from '../src/markup/index.js';
import { enhancedMarkupType } from '../src/markup/baseEnhanced.js';
import { validateText } from '../src/validation/index.js';

const globalsText = 'var e = 🡅\nvar g = 7';
const titlesText = 'title Gt (\nGlobal title #{g}x\n)';

/** The published converter on the lowered text: what every consumer builds today. */
function legacy(text: string, type = 'Weapon Trait', imports: Record<string, string> = {}) {
  const perk = (hash: number, main: string, perkType = 'Weapon Trait') =>
    ({
      hash,
      name: '',
      type: perkType,
      editor: { en: { main, secondary: main } },
    }) as unknown as IntermediatePerk;
  const database: Record<string, IntermediatePerk> = {
    1: perk(1, ''),
    2: perk(2, lowerDelimitedMarkup(globalsText)),
    3: perk(3, lowerDelimitedMarkup(titlesText)),
    42: perk(42, lowerDelimitedMarkup(text), type),
  };
  for (const [hash, main] of Object.entries(imports))
    database[hash] = perk(Number(hash), lowerDelimitedMarkup(main));
  return JSON.parse(
    JSON.stringify(
      descriptionConverter({
        descriptionString: lowerDelimitedMarkup(text),
        editorType: 'main',
        language: 'en',
        hash: 42,
        database,
      }),
    ),
  );
}

function preview(text: string, type?: string, imports: Record<string, string> = {}) {
  return JSON.parse(
    JSON.stringify(
      parseMarkup(text, {
        variables: globalsText,
        titles: titlesText,
        type,
        imports: { 1: '', 2: globalsText, 3: titlesText, ...imports },
      }),
    ),
  );
}

const plain = (lines: { linesContent?: { text?: string; classNames?: string[] }[] }[]) =>
  lines.map((line) =>
    (line.linesContent ?? [])
      .map((span) => (span.classNames?.includes('enhancedArrow') ? '^' : (span.text ?? '')))
      .join(''),
  );

describe('lowering', () => {
  test('a delimited variable lowers to #name when nothing merges', () => {
    expect(lowerDelimitedMarkup('Deals #{d} damage.')).toBe('Deals #d damage.');
    expect(lowerDelimitedMarkup('${1+#{d}}')).toBe('${1+#d}');
    expect(lowerDelimitedMarkup('<enhanced/> Lasts longer.')).toBe('#e Lasts longer.');
    expect(lowerDelimitedMarkup('<enhanced/>${10+#{d}}')).toBe('#e${10+#d}');
  });
  test('letters after a delimited form move into a holder declared on the next line', () => {
    expect(lowerDelimitedMarkup('#{d}x and #{d}px\nnext')).toBe(
      `#d#${holderName('x')} and #d#${holderName('px')}\nvar Zb1wx = x\nvar Zb2wpx = px\nnext`,
    );
    expect(lowerDelimitedMarkup('<enhanced/>Stronger')).toBe(
      '#e#Zb8wStronger\nvar Zb8wStronger = Stronger',
    );
    // `empty` is the converter's empty value, so that word is held in two parts.
    expect(lowerDelimitedMarkup('#{d}empty')).toBe(
      '#d#Zb4wempt#Zb1wy\nvar Zb4wempt = empt\nvar Zb1wy = y',
    );
  });
  test('lowering is exact and idempotent; text without the forms is the same string', () => {
    const text = 'Deals #d damage. #e ${1+2} {{a}{b}} #{} #{a b} <enhanced /> #{';
    expect(lowerDelimitedMarkup(text)).toBe(text);
    for (const source of ['#{d}x y #{d}', '<enhanced/>Ab\r\nmore #{q}1', 'var x = #{d}y']) {
      const once = lowerDelimitedMarkup(source);
      expect(lowerDelimitedMarkup(once)).toBe(once);
      expect(once).not.toMatch(/#\{[a-zA-Z0-9]+\}|<enhanced\/>/);
    }
  });
  test('holder names are prefix-free and recognisable', () => {
    const words = ['x', 'xy', 'x1', 'xQz', 'abcdefghijk', 'a', '1'];
    for (const a of words)
      for (const b of words)
        if (a !== b) expect(holderName(b).startsWith(holderName(a))).toBe(false);
    expect(isHolderName('Zb1wx')).toBe(true);
    expect(isHolderName('Zb2wx')).toBe(false);
    expect(isHolderName('d')).toBe(false);
  });
  test('references list both spellings with source offsets', () => {
    expect(variableReferences('a #{d}x #dx')).toEqual([
      { name: 'd', braced: true, from: 2, to: 6 },
      { name: 'dx', braced: false, from: 8, to: 11 },
    ]);
  });
  test('element tags lower first, then the delimited forms', () => {
    // The tag's closing ` />` is syntax, so its text meets the word after it: braces keep the
    // variable apart (`<solar #hit />tail` would read the variable #hittail).
    expect(lowerConsumerMarkup('<solar #{hit} />tail')).toBe(
      '<solar/>#hit#Zb4wtail\nvar Zb4wtail = tail',
    );
    expect(lowerConsumerMarkup('<solar #{hit}tail />')).toBe(
      '<solar/>#hit#Zb4wtail\nvar Zb4wtail = tail',
    );
  });
  test('markup-only edits: braces and the symbol that lower to the same text', () => {
    expect(isMarkupOnly('Deals #d damage.', 'Deals #{d} damage.')).toBe(true);
    expect(isMarkupOnly('#e Lasts longer.', '<enhanced/> Lasts longer.')).toBe(true);
    expect(isMarkupOnly('#dx', '#{d}x')).toBe(false);
  });
  test('merged variables name the longest defined prefix', () => {
    const defined = (name: string) => ['d', 'dm', 'e'].includes(name);
    expect(mergedVariable('dmx', defined)).toBe('dm');
    expect(mergedVariable('dx', defined)).toBe('d');
    expect(mergedVariable('dm', defined)).toBeUndefined();
    expect(mergedVariable('q', defined)).toBeUndefined();
  });
});

describe('preview equals the published converter on the lowered text', () => {
  const cases: [string, string, string?, Record<string, string>?][] = [
    ['merged letters', 'var d = 5\nDeals #{d}x damage, #{d}% more, and #{d}.'],
    ['nested math', 'var d = 5\nLasts ${1+#{d}} seconds and ${#{d}*2}x.'],
    ['global variable', 'Global #{g}x and #g.'],
    ['global title body', 'See <title this [Gt] />.'],
    ['local title', 'var d = 2\ntitle T (\nInside #{d}x\n)\n<title hover [T] />'],
    [
      'import of a braced variable',
      'import Shared from 77\nAfter.',
      undefined,
      {
        77: 'export Shared (\nvar s = 3\nShared #{s}x\n)',
      },
    ],
    ['main import', 'import main from 77', undefined, { 77: 'var s = 4\nWhole #{s}y' }],
    [
      'arrow on base',
      'Base text.\nenhanced (\nvar d = 1\n<enhanced/>Faster by #{d}s.\n)\n<enhanced/>${10+#{d}} total',
    ],
    [
      'arrow on enhanced',
      'Base text.\nenhanced (\nvar d = 1\n<enhanced/>Faster by #{d}s.\n)\n<enhanced/>${10+#{d}} total',
      enhancedMarkupType,
    ],
    [
      'legacy arrow beside the symbol',
      'enhanced (\nvar d = 1\n#e old <enhanced/>new\n)',
      enhancedMarkupType,
    ],
    ['symbol merges with a word', 'Up <enhanced/>Stronger', enhancedMarkupType],
    ['comment around a holder', 'var d = 3\n/* #{d}x\n*/ after #{d}y'],
    ['declaration using braces', 'var d = 3\nvar w = #{d}m\nWidth #w and #{w}s.'],
    ['empty value and empty word', 'var o = empty\nNothing: #{o}empty #{o}x'],
  ];
  test.each(cases)('%s', (_, text, type, imports = {}) => {
    const actual = preview(text, type, imports);
    expect(actual.lines).toEqual(legacy(text, type ?? 'Weapon Trait', imports));
  });

  test('rendered values', () => {
    expect(plain(preview('var d = 5\nDeals #{d}x damage.').lines)).toEqual(['Deals 5x damage.']);
    expect(plain(preview('var d = 5\n${1+#{d}}').lines)).toEqual(['6']);
    const text = 'Base text.\nenhanced (\nvar d = 1\n<enhanced/> Faster.\n)';
    expect(plain(preview(text).lines)).toEqual(['Base text.']);
    expect(plain(preview(text, enhancedMarkupType).lines)).toEqual(['Base text.', '^ Faster.']);
  });

  test('base/enhanced arms take braces and the symbol', () => {
    const text = 'var d = 2\n{{#{d}x base}{<enhanced/>#{d}y enhanced}}';
    expect(plain(preview(text).lines)).toEqual(['2x base']);
    expect(plain(preview(text, enhancedMarkupType).lines)).toEqual(['^2y enhanced']);
    expect(preview(text).diagnostics).toEqual([]);
  });
});

describe('validation', () => {
  const globals = { variables: globalsText, titles: '' };
  test('a merged plain reference warns and names the delimited fix', () => {
    const issues = validateText('var d = 5\nDeals #dx damage.', 'en', globals);
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: 'Variable #d merges with the text after it: write #{d}x.',
        code: 'merged-variable',
        from: 16,
        to: 19,
      }),
    ]);
  });
  test('#e followed by letters suggests the arrow symbol', () => {
    const [issue] = validateText('#eStronger', 'en', globals);
    expect(issue).toEqual(
      expect.objectContaining({
        message: 'The enhanced arrow #e merges with the text after it: write <enhanced/>Stronger.',
        code: 'merged-variable',
      }),
    );
  });
  test('the delimited form is clean; unknown variables still warn at their source', () => {
    expect(validateText('var d = 5\nDeals #{d}x damage.', 'en', globals)).toEqual([]);
    expect(validateText('Deals #{q}x.', 'en', globals)).toEqual([
      expect.objectContaining({ message: 'Unknown variable #q.', from: 6, to: 10 }),
    ]);
  });
});
