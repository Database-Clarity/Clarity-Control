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

function input(language: Lang, text?: string, sourceEnglish = english, edit?: (item: Tooltip) => void) {
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
  edit?.(item);
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
        expect(perk.editor[language]?.englishFallback).toBeUndefined();
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

  test.each(['stale', 'unfreezable', 'language-specific frozen'] as const)(
    '%s German fallback retains English dots and grouping',
    (reason) => {
      const sourceEnglish = 'Damage 4.5% for 2,985 frames x1.5 ${2.5+2}.';
      const source = input('de', 'Schaden #{=99}.', sourceEnglish, (item) => {
        if (reason === 'stale') {
          item.text.de!.text = 'Schaden 1,5.';
          item.text.de!.sourceUpdatedAt = '2025-01-01T00:00:00.000Z';
        } else {
          item.text.en!.numbers = {
            ids: numberSlots(sourceEnglish).map((_, index) => index + 1),
            next: 100,
            retired: { 99: reason === 'unfreezable' ? null : { value: '1.5', fallback: ['de'] } },
          };
        }
      });
      const perk = source.perks[100];
      if (!('editor' in perk)) throw new Error('Expected canonical fixture');
      expect(perk.editor.de?.main).toBe(perk.editor.en?.main);
      expect(perk.editor.de?.englishFallback).toBe(true);
      const golden = 'Damage 4.5% for 2,985 frames x1.5 4.5.';
      for (const preset of legacyPresets) {
        const descriptions = JSON.parse(new TextDecoder().decode(buildLegacy(source, preset)))[100].descriptions;
        expect(JSON.stringify(descriptions.en)).toContain(golden);
        if (preset !== 'vaultZero') expect(descriptions.de).toEqual(descriptions.en);
      }
      for (const style of styles) {
        const file = newStyleFile('numbers', style, {
          categories: ['perks'], sandboxPerks: [], frameAliases: false,
          languages: ['de'], keys: [], bungieIdentical: false,
        });
        const result = compile(source, file, {
          catalog: { items: { 100: { categoryId: 'perks' } }, categories: [{ id: 'perks' }] },
        });
        expect(JSON.stringify(result.expanded?.[100]?.descriptions.de)).toContain(golden);
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

test('unused global pairs preserve Locale identity for equal resolved translations', () => {
  const source = input('de', 'Duration #{=1} seconds.', 'Duration 4.5 seconds.');
  const forced = structuredClone(source);
  const variables = forced.perks[2];
  if (!('editor' in variables)) throw new Error('Expected variables library');
  for (const language of ['en', 'de'] as const)
    variables.editor[language] = { main: 'var Unused = {{1}{2}}', secondary: 'var Unused = {{1}{2}}' };
  const ordinary = JSON.parse(new TextDecoder().decode(buildLegacy(source, 'crayon')));
  const native = JSON.parse(new TextDecoder().decode(buildLegacy(forced, 'crayon')));
  expect(ordinary[100].descriptions.de).toContain('Duration 4,5 seconds.');
  expect(native[100].descriptions.de).toBe(ordinary[100].descriptions.de);
  for (const preset of legacyPresets)
    expect(buildLegacy(forced, preset), preset).toEqual(buildLegacy(source, preset));
});
