import { describe, expect, test } from 'vitest';
import { exportLegacy, languages, numberSlots, type Lang, type Tooltip } from '@clarity/core';
import { tooltip } from '../../core/test/helpers.js';
import { buildAllLegacy, buildLegacy, compile, legacyPresets, newStyleFile, styles, type LegacyInput } from '../src/index.js';
import { lowerInput } from '../src/elementTags.js';
import { doMath } from '../src/converter/converterFunctions/math.js';

const english = 'Damage 4.5% x1.5 1.5|2.5 1.5-2.5 2,985 7.3.5 ${5+#d}.\nvar d = 1.5';
const dotGolden = 'Translated 4.5% x1.5 1.5|2.5 1.5-2.5 2,985 7.3.5 6.5.';
const commaGolden = 'Translated 4,5% x1,5 1,5|2,5 1,5-2,5 2985 7.3.5 6,5.';
const commaLanguages = ['de', 'es', 'fr', 'it', 'pl', 'pt-br', 'ru'];

function tokenized(text: string): string {
  let result = text;
  for (const [index, slot] of [...numberSlots(text).entries()].reverse())
    result = result.slice(0, slot.from) + `#{=${index + 1}}` + result.slice(slot.to);
  return result;
}

function input(language: Lang, text?: string, sourceEnglish = english) {
  text ??= tokenized(sourceEnglish).replace('Damage', 'Translated');
  const base = tooltip();
  const item: Tooltip = {
    ...base,
    hash: 100,
    text: {
      en: { ...base.text.en!, text: sourceEnglish },
      [language]: {
        ...base.text.en!,
        text: language === 'en' ? sourceEnglish.replace('Damage', 'Translated') : text,
        sourceUpdatedAt: base.text.en!.updatedAt,
      },
    },
  };
  const globals = [1, 2, 3].map((hash) => ({
    ...base,
    hash,
    text: { en: { ...base.text.en!, text: '' } },
  }));
  const facts = Object.fromEntries(
    [1, 2, 3, 100].map((hash) => [hash, { name: 'Test', type: 'Weapon Perk' }]),
  );
  // Match the serialized liveDescriptions boundary consumed by the engine.
  return JSON.parse(JSON.stringify({ perks: exportLegacy([...globals, item], 0, facts) })) as LegacyInput;
}

describe('P11: language goldens through core export and all eight engine presets', () => {
  test('local titles format three-decimal numbers and stacks exactly once', () => {
    const source = input('de', undefined,
      'Damage 0.267 <title Tipp [tip] />.\ntitle tip (\nTitel 0.267 und 0.125|0.250 und ${0.5*3}\n)',
    );
    const titleGolden = 'Titel 0,267 und 0,125|0,250 und 1,5';
    for (const preset of legacyPresets) {
      const file = JSON.parse(new TextDecoder().decode(buildLegacy(source, preset)));
      const language = preset === 'vaultZero' ? 'en' : 'de';
      const description = JSON.stringify(file[100].descriptions[language]);
      expect(description).toContain(language === 'en' ? '0.267' : '0,267');
      if (preset === 'clarity' || preset === 'clarityV2')
        expect(description).toContain(titleGolden);
      else expect(description).not.toContain('Titel');
    }
    for (const style of styles) {
      const file = newStyleFile('numbers', style, {
        categories: ['perks'], sandboxPerks: [], frameAliases: false,
        languages: ['de'], keys: [], bungieIdentical: false,
      });
      // Text styles can explicitly inline title bodies instead of dropping them.
      if (style !== 'structured')
        file.format.titles = { mode: 'inline', pattern: ['', '', ' (', ')'] };
      const result = compile(source, file, {
        catalog: { items: { 100: { categoryId: 'perks' } }, categories: [{ id: 'perks' }] },
      });
      expect(JSON.stringify(result.expanded?.[100]?.descriptions.de)).toContain(titleGolden);
    }
  });

  test.each(languages)('%s: literals, stacks, ranges, grouping, and resolved maths', (language) => {
    const source = input(language);
    const stored = JSON.stringify(source);
    expect(stored).not.toContain('#{=');
    expect(stored).toContain('4.5%');
    expect(stored).toContain('${5+#d}');
    const golden = commaLanguages.includes(language) ? commaGolden : dotGolden;
    for (const preset of legacyPresets) {
      const file = JSON.parse(new TextDecoder().decode(buildLegacy(source, preset)));
      // Some presets only export English; every language they do export must match the golden.
      const descriptions = file[100]?.descriptions;
      expect(descriptions?.en).toBeDefined();
      if (preset !== 'vaultZero' || language === 'en') {
        expect(descriptions[language]).toBeDefined();
        expect(JSON.stringify(descriptions[language])).toContain(golden);
      }
    }
    for (const style of styles) {
      const file = newStyleFile('numbers', style, {
        categories: ['perks'], sandboxPerks: [], frameAliases: false,
        languages: [language], keys: [], bungieIdentical: false,
      });
      const result = compile(source, file, {
        catalog: { items: { 100: { categoryId: 'perks' } }, categories: [{ id: 'perks' }] },
      });
      expect(JSON.stringify(result.expanded?.[100]?.descriptions[language])).toContain(golden);
    }
  });

  test.each(['de', 'fr'] as const)(
    '%s: English-identical token translations keep local number formatting',
    (language) => {
      for (const sourceEnglish of ['Duration 4.5 seconds.', 'Duration ${2.5+2} seconds.']) {
        const source = input(language, 'Duration #{=1} seconds.', sourceEnglish);
        const literal = input(language, 'Duration 4,5 seconds.', sourceEnglish);
        const perk = source.perks[100];
        if (!('editor' in perk)) throw new Error('Expected canonical fixture');
        expect(perk.editor[language]?.main).toBe(perk.editor.en?.main);
        for (const preset of legacyPresets) {
          const bytes = buildLegacy(source, preset);
          const descriptions = JSON.parse(new TextDecoder().decode(bytes))[100].descriptions;
          if (preset !== 'vaultZero') {
            expect(JSON.stringify(descriptions[language])).toContain('Duration 4,5 seconds.');
            expect(bytes).toEqual(buildLegacy(literal, preset));
          }
          expect(JSON.stringify(descriptions.en)).toContain('Duration 4.5 seconds.');
        }
        for (const style of styles) {
          const file = newStyleFile('numbers', style, {
            categories: ['perks'], sandboxPerks: [], frameAliases: false,
            languages: [language], keys: [], bungieIdentical: false,
          });
          const result = compile(source, file, {
            catalog: { items: { 100: { categoryId: 'perks' } }, categories: [{ id: 'perks' }] },
          });
          expect(JSON.stringify(result.expanded?.[100]?.descriptions[language])).toContain(
            'Duration 4,5 seconds.',
          );
        }
      }
    },
  );

  test('formats prose after maths, while excluding identifiers, comments, and cell modifiers', () => {
    expect(
      doMath(
        '4.5 <title 4.5 [1.5] />\nimport x from 123\n// 4.5\n< table formula >\n|2 4.5 |b-2 1.5\n<$>\n${4.5+2}',
        'de',
      ),
    ).toBe(
      '4,5 <title 4,5 [1.5] />\nimport x from 123\n// 4.5\n< table formula >\n|2 4,5 |b-2 1,5\n<$>\n6,5',
    );
  });
});

describe('unresolved tokens fail closed at the engine boundary', () => {
  test.each(['#{=1}', '#{=unknown}', '#{=', '// #{=1}', '/* #{=1} */'])(
    '%s: main, secondary, globals, and non-English text',
    (token) => {
      for (const hash of ['1', '100'])
        for (const language of ['en', 'de'] as const)
          for (const field of ['main', 'secondary'] as const) {
            const source = input('de') as LegacyInput;
            const perk = source.perks[hash];
            if (!('editor' in perk)) throw new Error('Expected canonical perk');
            perk.editor[language] = { main: '', secondary: '', [field]: token };
            expect(() => lowerInput(source)).toThrow(
              `Unresolved number token in ${hash}/${language}`,
            );
            const build = buildAllLegacy(source, { descriptions: 1 }, { presets: legacyPresets });
            expect(build.files.every((file) => !file.ok)).toBe(true);
          }
    },
  );
});
