import { describe, expect, it } from 'vitest';
import { numberSlots, numberTemplate } from '../markup/numberSlots.js';
import { formatNumbers } from '../markup/numberFormat.js';
import { prepareMarkup } from '../markup/prepare.js';
import { parseMarkup } from '../markup/parse.js';
import { isMarkupOnly, lowerConsumerMarkup } from '../markup/braces.js';
import { enhancedMarkupType, scanBaseEnhanced } from '../markup/baseEnhanced.js';
import { alignSlots } from './identity.js';
import { carryNumberTranslations, canCarryNumbers, changedNumberSlots } from './carry.js';
import {
  numberTokens,
  numberValues,
  readNumberMap,
  reconcileNumberMap,
  resolveNumberTokens,
} from './map.js';
import { exportLegacy, usesEnglishFallback } from '../exportLegacy.js';
import { tooltipSchema, type LangText, type Tooltip } from '../schemas.js';
import { merge3 } from '../merge3.js';
import { publishableHash } from '../publishableHash.js';
import { languages } from '../languages.js';
import { gluedNumberIssues, validateNumberTooltip } from '../validation/numbers.js';

const oldDate = '2026-11-01T00:00:00.000Z',
  newDate = '2026-11-02T00:00:00.000Z';
const entry = (text: string, updatedAt = oldDate): LangText => ({
  text,
  updatedAt,
  updatedBy: 'author',
});
const translated = (text: string): LangText => ({ ...entry(text), sourceUpdatedAt: oldDate });
const tooltip = (en: string, de?: string): Tooltip => ({
  hash: 42,
  associated: [],
  text: { en: entry(en), ...(de === undefined ? {} : { de: translated(de) }) },
});
const update = (before: Tooltip, english: string): Tooltip => {
  const next: Tooltip = { ...before, text: { ...before.text, en: entry(english, newDate) } };
  next.text.en!.numbers = reconcileNumberMap(before.text.en, next.text.en!, next);
  return next;
};
const values = (text: string) => numberSlots(text).map((slot) => [slot.kind, slot.value]);
const replaceSlots = (text: string, replacements: string[]) => {
  let at = 0,
    result = '';
  numberSlots(text).forEach((slot, i) => {
    result += text.slice(at, slot.from) + replacements[i];
    at = slot.to;
  });
  return result + text.slice(at);
};

describe('number grammar', () => {
  it.each([
    ['5 4.5 0.267 -200 +10 2,985 39.5?', ['5', '4.5', '0.267', '-200', '+10', '2,985', '39.5?']],
    [
      '20% x2 2x 3+ 533ms 80HP ~500 1-3 10-20%',
      ['20', '2', '2', '3', '533', '80', '500', '1', '3', '10', '20'],
    ],
    ['1st 4th T1 #solar1 #{range0} range_0 7.3.5', []],
    [
      'import x from 123\ntitle 5 (\n5 seconds\n)\nexport 10 (\nvar d2 = 1.4\n)\n< weapon type ( T1 ) >',
      ['5', '1.4'],
    ],
    ['<title 5 [123] /> <link 6 [https://foo/7.2] /> <formula 8 [42.5] />', ['5', '6', '8']],
    ['1 /* 99 */ 2 // 88', ['1', '2']],
    ['1 /* 99 */ 2 // 88\n/* 77\n66 */ 3\n4', ['1', '3', '4']],
    ['<pve 215 /> <pvp [5] /> {{5}{7}} <solar 20 />', ['215', '5', '5', '7', '20']],
    ['< table formula >\n|2 4.5 |b-2 6.5 | 7|8\n<$>', ['4.5', '6.5', '7']],
  ])('detects prose in %s', (source, expected) =>
    expect(numberSlots(source).map((slot) => slot.value)).toEqual(expected),
  );
  it('keeps stacked and maths spans whole', () => {
    expect(values('6|9|12|15 33%|66%|100% 23.3% | 46.7% 1|2|…|6 ${4.5+#{d}}')).toEqual([
      ['S', '6|9|12|15'],
      ['S', '33%|66%|100%'],
      ['S', '23.3% | 46.7%'],
      ['S', '1|2|…|6'],
      ['M', '${4.5+#{d}}'],
    ]);
    for (const hash of [1, 2, 3]) expect(numberSlots('5', hash)).toEqual([]);
  });
  it('does not leak into other scanners or break native arms', () => {
    expect(scanBaseEnhanced('{{#{=1}}{#{=2}}}').issues).toEqual([]);
    expect(lowerConsumerMarkup('#{=1}')).toBe('#{=1}');
    expect(isMarkupOnly('5', '#{=1}', new Map([[1, '5']]))).toBe(true);
    expect(lowerConsumerMarkup(resolveNumberTokens('#{d}#{=1}x', new Map([[1, '5']])))).toContain(
      'var Zb2w5x = 5x',
    );
  });
});

describe('stable number identity', () => {
  it.each([
    ['Deals 10 #e damage.', 'Deals 10 <enhanced/> damage.'],
    ['Deals 10 #d damage.', 'Deals 10 #{d} damage.'],
    ['<solar/>Scorch 10 damage.', '<solar Scorch /> 10 damage.'],
  ])('preserves ordered ids on an exact markup-only respelling: %s', (before, after) => {
    const alignment = alignSlots(before, after);
    expect([...alignment.map]).toEqual([[0, 0]]);
    expect(alignment.kind).toBe('same');
    expect(alignment.changed).toEqual([]);
    const old = tooltip(before, 'Schaden #{=1}.');
    const next = update(old, after);
    expect(next.text.en!.numbers).toBeUndefined();
  });
  it('does not apply the markup-only exception when a number changes too', () => {
    const before = 'Deals 10 #e damage.',
      after = 'Deals 20 <enhanced/> damage.';
    expect(alignSlots(before, after).map.size).toBe(0);
    expect(update(tooltip(before, 'Schaden #{=1}.'), after).text.en!.numbers?.retired[1]).toBe(
      '10',
    );
  });
  it.each([
    [
      'owner value-only',
      'Grants 5 stacks. Each lasts 5 seconds.',
      'Grants 5 stacks. Each lasts 6 seconds.',
      2,
    ],
    [
      'owner restructured',
      'Grants 5 stacks. Each lasts 5 seconds.',
      'Each stack lasts 5 seconds. Grants up to 5 stacks.',
      0,
    ],
    ['removed one', 'Deals 10 damage and 10% more.', 'Deals 10 damage.', 0],
    ['inserted word', 'Deals 10 damage.', 'Deals 10 bonus damage.', 0],
    ['action reversed', 'Grants exactly 10 stacks.', 'Removes exactly 20 stacks.', 0],
    ['heading renamed', 'PvE:\nDeals 10 damage.', 'PvP:\nDeals 20 damage.', 0],
    ['duplicate deleted', 'Damage 10\nDamage 10', 'Damage 10', 0],
    [
      'text elsewhere',
      'PvE:\nDeals 10 damage.\nLasts 3 s.',
      'PvE:\nDeals 20 damage.\nLasts 3 seconds.',
      1,
    ],
    [
      'unique moved line',
      'A first line.\nDeals 10 damage.\nLast 5 s.',
      'Deals 12 damage.\nA first line, edited.\nLast 5 s.',
      2,
    ],
    [
      'moved dupes',
      'Grants 10 damage.\nGrants 20 damage.\nOther text.',
      'Grants 20 damage.\nOther text!\nGrants 10 damage.',
      0,
    ],
    [
      'anchored dupes',
      'Header:\nGrants 10 damage.\nGrants 20 damage.\nEnd 5.',
      'Header:\nGrants 10 damage.\nGrants 25 damage.\nEnd 5 s.',
      0,
    ],
    [
      'anchored moved',
      'Header:\nGrants 10 damage.\nGrants 20 damage.\nOther text.',
      'Header:\nGrants 20 damage.\nOther text!\nGrants 10 damage.',
      0,
    ],
    ['anchored deletion', 'Header:\nDamage 10\nDamage 20\nEnd.', 'Header:\nDamage 20\nEnd!', 0],
    [
      'P6 repeated insertion',
      'Intro.\nDamage 10\nDamage 20',
      'Intro.\nNote.\nDamage 10\nDamage 20',
      0,
    ],
    ['heading inserted', 'Damage 10.', 'PvP:\nDamage 10.', 0],
    [
      'title renamed',
      'Text.\ntitle a (\nDeals 10 damage.\n)',
      'Text!\ntitle b (\nDeals 10 damage.\n)',
      0,
    ],
    [
      'split into similar contexts',
      'Grenade Launchers: 11 Hits',
      'Area-Denial Grenade Launchers: 48? Hits\nOther Grenade Launchers: 11 Hits',
      0,
    ],
    ['inline scope', '<pve Deals 10 damage. />', '<pvp Deals 20 damage. />', 0],
    ['base scope', '{{Deals 10 damage.}{Nothing}}', '{{Nothing}{Deals 20 damage.}}', 0],
    [
      'cell scope',
      '< table wide >\n| Deals 10 damage. | Other\n<$>',
      '< table wide >\n| Other | Deals 20 damage.\n<$>',
      0,
    ],
    [
      'comments before heading',
      'PvE: // note\nDeals 10 damage.',
      'PvP: /* note */\nDeals 20 damage.',
      0,
    ],
  ])('%s', (_, before, after, kept) => expect(alignSlots(before, after).map.size).toBe(kept));

  it('P1-P6, P9: seeded substitutions, edit chains, scopes, determinism, and repeated rows', () => {
    let seed = 1114;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 150; run++) {
      const a = Math.floor(random() * 100),
        b = Math.floor(random() * 100);
      const source = `PvE:\nDamage ${a}.\nDuration ${b} s.\nPvP:\nOther 5 stacks.`;
      expect(alignSlots(source, source).map.size).toBe(3);
      const substitutions = [String(a + 1), String(b + 2), '5'];
      const next = replaceSlots(source, substitutions);
      const aligned = alignSlots(source, next);
      expect(aligned.kind).toBe('value');
      expect(aligned.changed).toEqual([0, 1]);
      expect(alignSlots(source, next)).toEqual(aligned);
      expect(numberTemplate(source)).toBe(numberTemplate(next));
      const added = source.replace('Duration', 'Note.\nDuration');
      expect(alignSlots(source, added).map.size).toBe(3);
      const edited = source.replace('PvE:', 'PvP:').replace('Other', 'Other excellent');
      const result = alignSlots(source, edited);
      for (const [old, fresh] of result.map)
        expect(result.before[old].scope).toBe(result.after[fresh].scope);
      let current = tooltip(source),
        highest = 3;
      const retiredIds = new Set<number>();
      for (let step = 0; step < 8; step++) {
        const changed = update(current, `Scope${step}:\nDamage ${Math.floor(random() * 100)}.`);
        const oldIds = readNumberMap(current.text.en!).ids;
        const newIds = readNumberMap(changed.text.en!).ids;
        for (const id of oldIds) if (!newIds.includes(id)) retiredIds.add(id);
        for (const id of newIds) {
          expect(retiredIds.has(id)).toBe(false);
          if (!oldIds.includes(id)) expect(id).toBeGreaterThan(highest);
          highest = Math.max(highest, id);
        }
        current = changed;
      }
    }
  });
});

describe('maps, validation, and export', () => {
  it('keeps implicit maps absent and prunes only retired values, never next', () => {
    const old = tooltip('Damage 5.', 'Schaden #{=1}.');
    expect(update(old, 'Damage 6.').text.en!.numbers).toBeUndefined();
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers).toEqual({ ids: [], next: 2, retired: { 1: '5' } });
    expect(resolveNumberTokens(next.text.de!.text, numberValues(next.text.en!))).toBe('Schaden 5.');
    delete next.text.de;
    expect(reconcileNumberMap(next.text.en, next.text.en!, next)).toEqual({
      ids: [],
      next: 2,
      retired: {},
    });
  });
  it('rejects invalid maps, token placements, and malformed ids, including comments', () => {
    for (const numbers of [
      { ids: [1, 1], next: 3, retired: {} },
      { ids: [1], next: 1, retired: {} },
      { ids: [1], next: 3, retired: { 1: '5' } },
    ])
      expect(
        tooltipSchema.safeParse({ ...tooltip('5'), text: { en: { ...entry('5'), numbers } } })
          .success,
      ).toBe(false);
    const wrong = tooltip('5', '#{=1}');
    wrong.text.en!.numbers = { ids: [], next: 1, retired: {} };
    expect(() => exportLegacy([wrong], 0)).toThrow('Number map');
    for (const text of [
      '#{=0}',
      '#{=01}',
      '#{=1:5}',
      '#{=1',
      '#{=9007199254740992}',
      '#{=99}',
      '// #{=99}',
      '/* #{=bad} */',
      'import #{=1} from 123',
      'title #{=1} (',
      '<link x [#{=1}] />',
      '<title x [#{=1}] />',
      '${5+#{=1}}',
    ]) {
      const item = tooltip('5', text);
      expect(validateNumberTooltip(item).length, text).toBeGreaterThan(0);
      expect(() => exportLegacy([item], 0), text).toThrow();
    }
    for (const text of ['// #{=1}', '/* #{=1} */', '<pve #{=1} />', 'var d = #{=1}']) {
      expect(validateNumberTooltip(tooltip('5', text))).toEqual([]);
      expect(JSON.stringify(exportLegacy([tooltip('5', text)], 0))).not.toContain('#{=');
    }
    expect(numberTokens('#{=1} #{d}')).toEqual([{ from: 0, to: 5, id: 1 }]);
    expect(() => exportLegacy([tooltip('#{=1}')], 0)).toThrow('belong in translations');
  });
  it('includes the optional map in publishableHash, preserving absent fields', async () => {
    const before = tooltip('5', '#{=1}');
    const after = structuredClone(before);
    after.text.en!.numbers = { ids: [2], next: 3, retired: { 1: '5' } };
    expect(await publishableHash(after)).not.toBe(await publishableHash(before));
  });
});

describe('proven carry and carry-aware merge', () => {
  it.each([
    '#{=1} Schaden. #x #x0\nvar x = 1',
    '#{=1} Schaden. #g #g0',
    '#{=1} Schaden. ${#g * 5}',
    '#{=1} Schaden. #{x} #x0\nvar x = 1',
  ])('refuses the four owner 15-11 counterexamples without globals: %s', (text) => {
    const old = tooltip('Damage 10.', text);
    expect(carryNumberTranslations(old, update(old, 'Damage 20.')).carried).toEqual([]);
  });
  it('keeps isolated braced globals and compares locally evaluated maths literals', () => {
    const separated = tooltip('Damage 10.', '#{=1} Schaden. #{g} 0');
    expect(carryNumberTranslations(separated, update(separated, 'Damage 20.')).carried).toEqual([
      'de',
    ]);
    const sameOld = tooltip('Damage 10.', '#{=1} Schaden. ${#x * 5}\nvar x = 2');
    expect(carryNumberTranslations(sameOld, update(sameOld, 'Damage 20.')).carried).toEqual([]);
    const hiddenOverride = tooltip(
      'Damage 10.',
      '#{=1} Schaden. ${#x * 5}\nvar x = 3\n/*\nvar x = 2\n*/',
    );
    expect(
      carryNumberTranslations(hiddenOverride, update(hiddenOverride, 'Damage 20.')).carried,
    ).toEqual([]);
    const different = tooltip('Damage 10.', '#{=1} Schaden. ${#x * 5}\nvar x = 3');
    expect(carryNumberTranslations(different, update(different, 'Damage 20.')).carried).toEqual([
      'de',
    ]);
  });
  it('refuses a changed formula whose local can be overridden by an import', () => {
    const old = tooltip(
      'Damage ${#d * #k}.\nvar d = 5\nvar k = 2\nimport stats from 100',
      'Schaden #{=1} (vorher 14).\nvar d = #{=2}\nvar k = #{=3}\nimport stats from 100',
    );
    const next = update(old, old.text.en!.text.replace('k = 2', 'k = 3'));
    const globals = {
      variables: '',
      titles: '',
      imports: { 100: 'export stats (\nvar d = 7\n)' },
    };
    expect(prepareMarkup(old.text.en!.text, globals, []).text).toBe('Damage 14.');
    expect(prepareMarkup(next.text.en!.text, globals, []).text).toBe('Damage 21.');
    const exported = exportLegacy([next], 0)[42];
    if ('aliasOf' in exported) throw Error('alias');
    expect(prepareMarkup(exported.editor.de!.main!, globals, []).text).toBe(
      'Schaden 21 (vorher 14).',
    );
    expect(carryNumberTranslations(old, next).carried).toEqual([]);
  });
  it.each([
    ['#{g}0', 'var g = 1', {}],
    ['1#{g}0', 'var g = empty', {}],
    ['#{v}0\nimport v from 100', '', { 100: 'export v (\nvar v = 1\n)' }],
  ] as const)(
    'refuses digits joined to an external reference: %s',
    (literal, variables, imports) => {
      const old = tooltip('Damage 10.', `#{=1} Schaden. ${literal}`);
      const next = update(old, 'Damage 20.');
      expect(
        prepareMarkup(
          resolveNumberTokens(old.text.de!.text, numberValues(old.text.en!)),
          { variables, titles: '', imports },
          [],
        ).text,
      ).toBe('10 Schaden. 10');
      expect(gluedNumberIssues(old.text.de!.text)).toContainEqual(
        expect.objectContaining({ severity: 'error', code: 'glued-number' }),
      );
      expect(carryNumberTranslations(old, next).carried).toEqual([]);
    },
  );
  it('still carries an isolated shared text reference', () => {
    const old = tooltip('Damage 10.', '#{=1} Schaden. #{CombatantClassifications}');
    expect(carryNumberTranslations(old, update(old, 'Damage 20.')).carried).toEqual(['de']);
  });
  it('requires formula coverage through every duplicate local declaration', () => {
    const old = tooltip(
      'Damage ${#d * 2}.\nvar d = 5\nenhanced (\nvar d = #x\n)\nvar x = 10',
      'Schaden 20 (Basis #{=3}).',
    );
    const next = update(old, old.text.en!.text.replace('x = 10', 'x = 20'));
    const globals = { variables: '', titles: '', type: enhancedMarkupType };
    expect(prepareMarkup(old.text.en!.text, globals, []).text).toBe('Damage 20.');
    expect(prepareMarkup(next.text.en!.text, globals, []).text).toBe('Damage 40.');
    expect([...changedNumberSlots(old.text.en!.text, next.text.en!.text)]).toEqual([2, 0]);
    expect(carryNumberTranslations(old, next).carried).toEqual([]);
  });
  it.each(['#d * #g', '#d * #a'])(
    'refuses carry when a changed formula depends on a shared variable: %s',
    (formula) => {
      const alias = formula.includes('#a') ? '\nvar a = #g' : '';
      const old = tooltip(
        `Damage \${${formula}}.\nvar d = 5${alias}`,
        'Schaden #{=1} (vorher 10).\nvar d = #{=2}' + alias,
      );
      const next = update(old, old.text.en!.text.replace('d = 5', 'd = 6'));
      const render = (item: Tooltip, lang: 'en' | 'de') => {
        const exported = exportLegacy([item], 0)[42];
        if ('aliasOf' in exported) throw Error('alias');
        return prepareMarkup(
          exported.editor[lang]!.main!,
          { variables: 'var g = 2', titles: '' },
          [],
        ).text;
      };
      expect(render(old, 'en')).toBe('Damage 10.');
      expect(render(next, 'en')).toBe('Damage 12.');
      expect(render(next, 'de')).toBe('Schaden 12 (vorher 10).');
      expect(carryNumberTranslations(old, next).carried).toEqual([]);
    },
  );
  it.each([
    ['1<enhanced/>0\nenhanced (\nUnused.\n)', false],
    ['#{v}0\nvar v = 1', true],
    ['1#{v}0\nvar v = empty', true],
  ] as const)(
    'refuses a stale literal joined by consumer substitutions: %s',
    (literal, forbidden) => {
      const old = tooltip('Damage 10.', `#{=1} Schaden. ${literal}`);
      const next = update(old, 'Damage 20.');
      expect(
        prepareMarkup(
          resolveNumberTokens(old.text.de!.text, numberValues(old.text.en!)),
          { variables: '', titles: '' },
          [],
        ).text,
      ).toBe('10 Schaden. 10');
      expect(gluedNumberIssues(old.text.de!.text).length > 0).toBe(forbidden);
      expect(carryNumberTranslations(old, next).carried).toEqual([]);
    },
  );
  it('requires token coverage for an actual legacy prefix-driven formula change', () => {
    const old = tooltip('Damage ${#{d5}}.\nvar d = 10\n#d', 'Schaden 105, #{=2}.\nvar d = #{=2}');
    const next = update(old, 'Damage ${#{d5}}.\nvar d = 20\n#d');
    expect([...changedNumberSlots(old.text.en!.text, next.text.en!.text)]).toEqual([1, 0]);
    expect(prepareMarkup(old.text.en!.text, { variables: '', titles: '' }, []).text).toBe(
      'Damage 105.\n10',
    );
    expect(prepareMarkup(next.text.en!.text, { variables: '', titles: '' }, []).text).toBe(
      'Damage 205.\n20',
    );
    expect(carryNumberTranslations(old, next).carried).toEqual([]);
  });
  it.each(['1/* note */0', '1\r0'])(
    'refuses an old literal joined by consumer cleanup: %s',
    (literal) => {
      const old = tooltip('Damage 10.', `#{=1} Schaden. ${literal} Schaden.`);
      const next = update(old, 'Damage 20.');
      const exported = exportLegacy([old], 0)[42];
      if ('aliasOf' in exported) throw Error('alias');
      expect(prepareMarkup(exported.editor.de!.main!, { variables: '', titles: '' }, []).text).toBe(
        '10 Schaden. 10 Schaden.',
      );
      expect(carryNumberTranslations(old, next).carried).toEqual([]);
    },
  );
  it.each([
    ['Lasts 10 seconds.', 'Lasts 12 seconds.', 'Dauer #{=1} s (Basis 5-10 s).'],
    ['Recoil -10.', 'Recoil -12.', 'Rückstoß #{=1} (verringert um 10).'],
    ['Deals 10,000 damage.', 'Deals 12,000 damage.', '#{=1} Schaden (vorher 10.000).'],
    ['Deals 10,000 damage.', 'Deals 12,000 damage.', '#{=1} dégâts (avant 10 000).'],
    ['Deals 10,000 damage.', 'Deals 12,000 damage.', '#{=1} dégâts (avant 10 000).'],
    ['Lasts 10 seconds.', 'Lasts 12 seconds.', '#{=1}秒持続（基本１０秒）。'],
    ['Lasts 4.5 seconds.', 'Lasts 6.5 seconds.', '#{=1}秒持続（基本４，５秒）。'],
  ])('P8 refuses ambiguous signed, grouped, and full-width copies: %s', (before, after, text) => {
    const old = tooltip(before, text);
    expect(canCarryNumbers(old.text.en!, update(old, after).text.en!, old.text.de!)).toBe(false);
  });
  it.each([
    '#{=1}스택을 얻습니다. 최대 5스택.',
    '#{=1}秒間持続（基本5秒間）。',
    '#{=1} Stapel (5fach).',
    '#{=1}层，最多5层。',
  ])('refuses an old literal embedded in translated words: %s', (text) => {
    const old = tooltip('Grants 5 stacks.', text);
    expect(
      canCarryNumbers(old.text.en!, update(old, 'Grants 6 stacks.').text.en!, old.text.de!),
    ).toBe(false);
  });
  it('refuses a typed old formula result adjacent to CJK characters', () => {
    const old = tooltip(
      'var d = 5\nDeals ${#d*2} damage.',
      'var d = #{=1}\n造成#{=2}点伤害（即10点）。',
    );
    expect(
      canCarryNumbers(
        old.text.en!,
        update(old, 'var d = 6\nDeals ${#d*2} damage.').text.en!,
        old.text.de!,
      ),
    ).toBe(false);
  });
  it('ignores old literals in comments, without joining digits across removed tokens', () => {
    const old = tooltip('Grants 5 stacks.', '#{=1} Stapel. // 5fach');
    const next = update(old, 'Grants 6 stacks.');
    expect(canCarryNumbers(old.text.en!, next.text.en!, old.text.de!)).toBe(true);
    expect(canCarryNumbers(old.text.en!, next.text.en!, translated('5#{=1}0'))).toBe(false);
  });
  it('keeps the complete head map on a retry of identical authored English', () => {
    const base = tooltip('Damage 5.', 'Schaden #{=1}.');
    const head = update(base, 'Grants 3 and 5 damage.');
    const retry = structuredClone(head);
    delete retry.text.en!.numbers;
    retry.text.en!.updatedAt = '2026-11-03T00:00:00.000Z';
    expect(head.text.en!.numbers?.retired[1]).toBe('5');
    expect(merge3(base, head, retry)).toEqual({ ok: true, merged: head });
    const stale = structuredClone(retry);
    stale.text.en!.numbers = { ids: [7, 8], next: 9, retired: {} };
    expect(merge3(base, head, stale)).toEqual({ ok: true, merged: head });
  });
  it('tracks a changed var value when its digits also appear in the variable name', () => {
    const old = tooltip('Damage ${#d5*2}.\nvar d5 = 5', '10 Schaden\nvar d5 = #{=2}');
    const next = update(old, 'Damage ${#d5*2}.\nvar d5 = 6');
    expect([...changedNumberSlots(old.text.en!.text, next.text.en!.text)]).toEqual([1, 0]);
    expect(canCarryNumbers(old.text.en!, next.text.en!, old.text.de!)).toBe(false);
  });
  it('P8: requires coverage, rejects old literals and stale translations, and keeps author', () => {
    const original = tooltip(
      'Grants 5 stacks. Lasts 5 seconds.',
      'Hält #{=2} Sekunden, bis zu #{=1} Stapel.',
    );
    const next = update(original, 'Grants 5 stacks. Lasts 6 seconds.');
    const result = carryNumberTranslations(original, next);
    expect(result.carried).toEqual(['de']);
    expect(result.tooltip.text.de).toEqual({
      ...original.text.de,
      updatedAt: newDate,
      sourceUpdatedAt: newDate,
    });
    for (const text of ['5 Sekunden', '#{=1}', '#{=2} + 5', '#{=2} + 5,0'])
      expect(canCarryNumbers(original.text.en!, next.text.en!, translated(text)), text).toBe(false);
    expect(
      canCarryNumbers(original.text.en!, next.text.en!, {
        ...original.text.de!,
        sourceUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
    const stack = tooltip('10|20 damage.', '10 / 20');
    expect(
      canCarryNumbers(stack.text.en!, update(stack, '11|21 damage.').text.en!, stack.text.de!),
    ).toBe(false);
    const math = tooltip('Damage ${5*2}.', '#{=1} plus 10');
    expect(
      canCarryNumbers(math.text.en!, update(math, 'Damage ${6*2}.').text.en!, math.text.de!),
    ).toBe(false);
  });
  it('includes formula dependencies and normalises comma literals', () => {
    const old = tooltip('Damage ${#d*2}.\nvar d = 5', '10 Schaden\nvar d = #{=2}');
    const next = update(old, 'Damage ${#d*2}.\nvar d = 6');
    expect([...changedNumberSlots(old.text.en!.text, next.text.en!.text)]).toEqual([1, 0]);
    expect(canCarryNumbers(old.text.en!, next.text.en!, old.text.de!)).toBe(false);
    expect(
      canCarryNumbers(old.text.en!, next.text.en!, translated('#{=1} Schaden\nvar d = #{=2}')),
    ).toBe(true);
    const decimal = tooltip('4.5 damage.', '#{=1} and 4,5');
    expect(
      canCarryNumbers(decimal.text.en!, update(decimal, '6.5 damage.').text.en!, decimal.text.de!),
    ).toBe(false);
  });
  it('merges both save orders, retries, and refuses two translators', () => {
    const base = tooltip('Damage 5.', 'Schaden #{=1}.');
    const editor = carryNumberTranslations(base, update(base, 'Damage 6.')).tooltip;
    const translator = structuredClone(base);
    translator.text.de = {
      ...translated('Neuer Schaden #{=1}.'),
      updatedBy: 'translator',
      updatedAt: newDate,
    };
    const a = merge3(base, translator, update(base, 'Damage 6.'));
    expect(a.ok).toBe(true);
    if (a.ok)
      expect(carryNumberTranslations(translator, a.merged).tooltip.text.de?.sourceUpdatedAt).toBe(
        newDate,
      );
    const b = merge3(base, editor, translator);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.merged.text.de).toEqual({ ...translator.text.de, sourceUpdatedAt: newDate });
    const literal = structuredClone(translator);
    literal.text.de!.text += ' 5';
    const c = merge3(base, editor, literal);
    if (!c.ok) throw Error('carry metadata conflicted');
    expect(c.merged.text.de?.sourceUpdatedAt).toBe(oldDate);
    expect(merge3(base, editor, update(base, 'Damage 6.'))).toEqual({ ok: true, merged: editor });
    expect(merge3(base, translator, literal).ok).toBe(false);
    const wording = update(base, 'Grants 6 damage.');
    expect(merge3(base, wording, translator).ok).toBe(true);
  });
});

describe('retired formula freezing', () => {
  it('fails closed when an unresolved longer reference depends on a shorter local prefix', () => {
    const old = tooltip('Damage ${#{d5}}.\nvar d = 10\n#d', 'Schaden #{=1}, #d.\nvar d = #{=2}');
    const render = (item: Tooltip) => {
      const exported = exportLegacy([item], 0)[42];
      if ('aliasOf' in exported) throw Error('alias');
      return prepareMarkup(exported.editor.de!.main!, { variables: '', titles: '' }, []).text;
    };
    expect(render(old)).toBe('Schaden 105, 10.');
    const retired = update(old, 'Nothing.\nvar d = 10');
    expect(retired.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(retired, 'de')).toBe(true);
    const later = update(retired, 'Nothing.\nvar d = 20');
    expect(later.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(later, 'de')).toBe(true);
    expect(render(retired)).toBe('Nothing.');
    expect(render(later)).toBe('Nothing.');
  });
  it.each(['/* note */ 10', '10 // note'])(
    'fails closed on commented numeric declaration %s',
    (value) => {
      const old = tooltip('Damage ${5+#d}.\nvar d = ' + value, 'Schaden #{=1}.\nvar d = ' + value);
      const next = update(old, 'Nothing.');
      expect(next.text.en!.numbers?.retired[1]).toBeNull();
      expect(usesEnglishFallback(next, 'de')).toBe(true);
    },
  );
  it('fails closed on legacy variable-prefix substitution', () => {
    const old = tooltip(
      'Damage ${5+#d+#d5}.\nvar d = 1\nvar d5 = 2',
      'Schaden #{=1}.\nvar d = #{=2}\nvar d5 = #{=3}',
    );
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(next, 'de')).toBe(true);
  });
  it('checks prefix ambiguity in the translation, including references outside the formula', () => {
    const old = tooltip(
      'Damage ${5+#d}.\nvar d = 1',
      'Schaden #{=1}, extra #d5.\nvar d = #{=2}\nvar d5 = 2',
    );
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toEqual({ value: '${5+1}', fallback: ['de'] });
    expect(usesEnglishFallback(next, 'de')).toBe(true);
  });
  it('falls back when imports may override a local declaration, through the real resolver', () => {
    const imported = 'export stats (\nvar d = 20\n)';
    const old = tooltip(
      'import stats from 100\nDamage ${5+#d}.\nvar d = 10',
      'var d = #{=2}\nimport stats from 100\nSchaden #{=1}.',
    );
    expect(
      prepareMarkup(
        resolveNumberTokens(old.text.de!.text, numberValues(old.text.en!)),
        { variables: '', titles: '', imports: { 100: imported } },
        [],
      ).text,
    ).toBe('Schaden 25.');
    const next = update(old, 'Nothing.');
    expect(usesEnglishFallback(next, 'de')).toBe(true);
    const translationOnly = tooltip('Damage ${5+#d}.\nvar d = 10', old.text.de!.text);
    expect(update(translationOnly, 'Nothing.').text.en!.numbers?.retired[1]).toEqual({
      value: '${5+10}',
      fallback: ['de'],
    });
  });
  it('matches the numeric slot after extra declaration whitespace', () => {
    const old = tooltip('Damage ${5+#d}.\nvar d =  \t10', 'Schaden #{=1}.\nvar d = #{=2}');
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toBe('${5+10}');
    expect(usesEnglishFallback(next, 'de')).toBe(false);
    expect(
      prepareMarkup(
        resolveNumberTokens(next.text.de!.text, numberValues(next.text.en!)),
        { variables: '', titles: '' },
        [],
      ).text,
    ).toBe('Schaden 15.');
  });
  it('fails closed when a commented declaration also participates in the real resolver', () => {
    const old = tooltip(
      'Damage ${5+#d}.\nvar d = 10\n/*\nvar d = 20\n*/',
      'Schaden #{=1}.\nvar d = #{=2}\n/*\nvar d = 20\n*/',
    );
    expect(
      prepareMarkup(
        resolveNumberTokens(old.text.de!.text, numberValues(old.text.en!)),
        { variables: '', titles: '' },
        [],
      ).text,
    ).toBe('Schaden 25.');
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(next, 'de')).toBe(true);
  });
  it('P10: freezes locals, records language disagreement, and stays frozen across later edits', () => {
    const old = tooltip('Damage ${5+#d}.\nvar d = 10', 'Schaden #{=1}.\nvar d = #{=2}');
    old.text.fr = translated('Dégâts #{=1}.\nvar d = 20');
    const next = update(old, 'No damage.\nvar d = 10');
    expect(next.text.en!.numbers?.retired[1]).toEqual({ value: '${5+10}', fallback: ['fr'] });
    expect(usesEnglishFallback(next, 'de')).toBe(false);
    expect(usesEnglishFallback(next, 'fr')).toBe(true);
    for (const item of [next, update(next, 'Nothing.\nvar d = 30')]) {
      const raw = resolveNumberTokens(item.text.de!.text, numberValues(item.text.en!, 'de'));
      expect(prepareMarkup(raw, { variables: '', titles: '' }, []).text).toBe('Schaden 15.');
      const exported = exportLegacy([item], 0)['42'];
      if ('aliasOf' in exported) throw Error('alias');
      expect(exported.editor.fr?.main).toBe(item.text.en!.text);
    }
  });
  it.each([
    'var d = word',
    'var d = 10\nvar d = 20',
    'enhanced (\nvar d = 10\n)',
    'var d = #a\nvar a = #d',
  ])('refuses unsafe locals: %s', (declarations) => {
    const old = tooltip('Damage ${5+#d}.\n' + declarations, 'Schaden #{=1}.\nvar d = 10');
    const next = update(old, 'No damage.');
    expect(next.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(next, 'de')).toBe(true);
  });
  it('inlines transitive locals, preserves shared references, and validates tokens in comments', () => {
    const old = tooltip(
      'Damage ${5+#{d}+#global}.\nvar d = #a\nvar a = 3',
      '// #{=1}\nvar d = 3\nvar a = #{=2}',
    );
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toBe('${5+3+#global}');
    expect(validateNumberTooltip(next)).toEqual([]);
    expect(JSON.stringify(exportLegacy([next], 0))).not.toContain('#{=');
  });
  it('preserves the actual resolver result when a local value is itself a formula', () => {
    const old = tooltip(
      'Damage ${5+#d}.\nvar d = ${2+#a}\nvar a = 3',
      'Schaden #{=1}.\nvar d = #{=2}\nvar a = #{=3}',
    );
    const next = update(old, 'Nothing.');
    expect(next.text.en!.numbers?.retired[1]).toBeNull();
    expect(usesEnglishFallback(next, 'de')).toBe(true);
    const render = (item: Tooltip) =>
      prepareMarkup(
        resolveNumberTokens(item.text.de!.text, numberValues(item.text.en!, 'de')),
        { variables: '', titles: '' },
        [],
      ).text;
    expect(render(old)).toBe('Schaden 5}.');
  });
});

describe('language formatting', () => {
  it('formats shared title bodies only after their variables and maths resolve', () => {
    const parsed = parseMarkup('<title label [decimal] />', {
      variables: '',
      titles: 'title decimal (\nvar d = 1.5\nDamage ${5+#d}.\n)',
      lang: 'de',
    });
    expect(JSON.stringify(parsed.lines)).toContain('Damage 6,5.');
  });
  it('P11: formats only prose, after maths, and keeps dot languages byte-identical', () => {
    const source =
      '4.5% x1.5 1.5|2.5 1.5-2.5 2,985 7.3.5 <title 4.5 [1.5] />\nimport x from 123\n// 4.5\n< table formula >\n|2 4.5 |b-2 1.5\n<$>\n${4.5+2}';
    for (const lang of languages) {
      const formatted = formatNumbers(source, lang);
      if (['de', 'es', 'fr', 'it', 'pl', 'pt-br', 'ru'].includes(lang)) {
        expect(formatted).toBe(
          '4,5% x1,5 1,5|2,5 1,5-2,5 2985 7.3.5 <title 4,5 [1.5] />\nimport x from 123\n// 4.5\n< table formula >\n|2 4,5 |b-2 1,5\n<$>\n${4.5+2}',
        );
        const raw = 'Damage ${5+#d}.\nvar d = 1.5';
        expect(prepareMarkup(raw, { variables: '', titles: '', lang }, []).text).toBe(
          'Damage 6,5.',
        );
      } else expect(formatted).toBe(source);
      expect(formatNumbers('10 damage, 20 stacks.', lang)).toBe('10 damage, 20 stacks.');
    }
  });
});

it('P8 and P10: seeded coverage subsets and retirement histories', () => {
  let seed = 581;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 80; run++) {
    const a = 1 + Math.floor(random() * 50),
      b = 51 + Math.floor(random() * 50);
    const original = tooltip(`Damage ${a}. Duration ${b}.`, '#{=1} #{=2}');
    const next = update(original, `Damage ${a + 1}. Duration ${b + 2}.`);
    for (let mask = 0; mask < 4; mask++) {
      const words = [mask & 1 ? '#{=1}' : 'absent', mask & 2 ? '#{=2}' : 'absent'].join(' ');
      expect(canCarryNumbers(original.text.en!, next.text.en!, translated(words))).toBe(mask === 3);
      expect(canCarryNumbers(original.text.en!, next.text.en!, translated(words + ' ' + a))).toBe(
        false,
      );
    }
    const formula = tooltip(`Damage \${${a}+#d}.\nvar d = ${b}`, '#{=1} Schaden.\nvar d = #{=2}');
    const beforeRender = prepareMarkup(
      resolveNumberTokens(formula.text.de!.text, numberValues(formula.text.en!)),
      { variables: '', titles: '' },
      [],
    ).text;
    let retired = update(formula, `No damage.\nvar d = ${b}`);
    for (let step = 0; step < 4; step++) {
      retired = update(retired, `No damage!\nvar d = ${b + step + 1}`);
      const rendered = prepareMarkup(
        resolveNumberTokens(retired.text.de!.text, numberValues(retired.text.en!)),
        { variables: '', titles: '' },
        [],
      ).text;
      expect(rendered).toBe(beforeRender);
    }
  }
});

it.each(['Damage 7.', 'Damage 5.', 'New damage 7.'])(
  'merges an intermediate carry followed by %s without a false content conflict',
  (english) => {
    const base = tooltip('Damage 5.', 'Schaden #{=1}.');
    const first = carryNumberTranslations(base, update(base, 'Damage 6.')).tooltip;
    const laterDate = '2026-11-03T00:00:00.000Z';
    const second = update(first, english);
    second.text.en!.updatedAt = laterDate;
    const head = carryNumberTranslations(first, second).tooltip;
    const translator = structuredClone(base);
    translator.text.de!.text = 'Neuer Schaden #{=1}.';
    translator.text.de!.updatedAt = laterDate;
    for (const result of [merge3(base, head, translator), merge3(base, translator, head)]) {
      if (!result.ok) throw new Error(JSON.stringify(result.conflicts));
      expect(result.merged.text.de).toEqual({
        ...translator.text.de,
        sourceUpdatedAt: english === 'New damage 7.' ? oldDate : laterDate,
      });
    }
  },
);

it('P3 and P9: every word-step carry has equal, uniquely anchored windows', () => {
  const context = (source: string) => {
    let index = 0;
    return numberTemplate(source)
      .split('\n')
      .flatMap((line, lineNo) => {
        // eslint-disable-next-line no-control-regex -- The template separator is intentional.
        const units = line.match(/\u001f[NMS]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
        return units.flatMap((unit, at) =>
          unit.startsWith('\u001f')
            ? [
                {
                  index: index++,
                  line: lineNo,
                  key: JSON.stringify(units),
                  two: JSON.stringify(
                    units.slice(Math.max(0, at - 2), at + 3).map((word) => word.toLowerCase()),
                  ),
                  three: JSON.stringify(
                    units.slice(Math.max(0, at - 3), at + 4).map((word) => word.toLowerCase()),
                  ),
                },
              ]
            : [],
        );
      });
  };
  let seed = 312;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 100; run++) {
    const n = Math.floor(random() * 100);
    const before = `Alpha words grant exactly ${n} stacks for seconds.\nDuplicate 5 damage.\nDuplicate 10 damage.`;
    const after =
      random() < 0.5
        ? before.replace('Alpha', 'Beta').replace(String(n), String(n + 1))
        : before.replace('grant', 'remove');
    const aligned = alignSlots(before, after);
    const old = context(before),
      next = context(after);
    const unmatchedLine = (
      slots: ReturnType<typeof context>,
      steps: typeof aligned.steps,
      index: number,
    ) =>
      !slots.some(
        (slot) => slot.line === index && ['line', 'moved'].includes(steps.get(slot.index) ?? ''),
      );
    const nextSteps = new Map([...aligned.map].map(([a, b]) => [b, aligned.steps.get(a)!]));
    for (const [a, b] of aligned.map) {
      if (aligned.kind === 'text') {
        expect(aligned.before[a].scope).toBe(aligned.after[b].scope);
        expect(old.filter((slot) => slot.key === old[a].key)).toHaveLength(1);
        expect(next.filter((slot) => slot.key === next[b].key)).toHaveLength(1);
      }
      if (aligned.steps.get(a) === 'word') {
        expect(old[a].two).toBe(next[b].two);
        expect(
          old.filter(
            (slot) => unmatchedLine(old, aligned.steps, slot.line) && slot.three === old[a].three,
          ),
        ).toHaveLength(1);
        expect(
          next.filter(
            (slot) => unmatchedLine(next, nextSteps, slot.line) && slot.three === next[b].three,
          ),
        ).toHaveLength(1);
      }
    }
  }
});
