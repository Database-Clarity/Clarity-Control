import { describe, expect, test } from 'vitest';
import { exportLegacy, languages, numberSlots, type Lang, type Tooltip } from '@clarity/core';
import { tooltip } from '../../core/test/helpers.js';
import { buildAllLegacy, buildLegacy, legacyPresets, type LegacyInput } from '../src/index.js';
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

function input(language: Lang, text = tokenized(english).replace('Damage', 'Translated')) {
  const base = tooltip();
  const item: Tooltip = {
    ...base,
    hash: 100,
    text: {
      en: { ...base.text.en!, text: english },
      [language]: {
        ...base.text.en!,
        text: language === 'en' ? english.replace('Damage', 'Translated') : text,
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
  return { perks: exportLegacy([...globals, item], 0, facts) };
}

describe('P11: language goldens through core export and all eight engine presets', () => {
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
  });

  test.each(['de', 'fr'] as const)('%s: English fallback retains dots and grouping', (language) => {
    const source = input(language, english);
    for (const preset of legacyPresets) {
      const file = JSON.parse(new TextDecoder().decode(buildLegacy(source, preset)));
      const descriptions = file[100]?.descriptions;
      if (descriptions[language]) expect(descriptions[language]).toEqual(descriptions.en);
    }
  });

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
