import { describe, expect, test } from 'vitest';
import {
  convertWeaponTypeSyntax,
  completeWeaponTypeLabels,
  englishWeaponTypeLabels,
  hasOldWeaponTypeSyntax,
  markupWeaponTypes,
  migrateWeaponTypeSyntax,
  parseMarkup,
  specializeWeaponTypes,
  validateText,
  validateWeaponSections,
  weaponTypeLabel,
  weaponTypeLabelsSchema,
  weaponTypeNames,
} from '../src/index.js';

const texts = (lines: ReturnType<typeof parseMarkup>['lines']) =>
  lines.map((line) => line.linesContent?.map((span) => span.text ?? '').join('') ?? '[table]');

const tagged = [
  'Shared.',
  '<weapons Sword, Hand Cannon>',
  'Melee and cannons.',
  '</weapons>',
  '<weapons other>',
  'Everything else.',
  '</weapons>',
].join('\n');

describe('canonical vocabulary', () => {
  test('lists the 17 Bungie weapon types and keeps ability tags as extras', () => {
    expect(weaponTypeNames).toHaveLength(17);
    expect(markupWeaponTypes).toEqual(
      expect.arrayContaining(['Grenade', 'Melee', 'Super', 'Heavy Grenade Launcher']),
    );
    for (const name of markupWeaponTypes)
      expect(englishWeaponTypeLabels[name]).toEqual({ en: name });
  });
});

describe('weapon type labels', () => {
  const table = {
    'Hand Cannon': { en: 'Hand Cannon', de: 'Handfeuerwaffe' },
    Sword: { en: 'Sword' },
  };

  test('resolver falls back from language to English to the canonical name', () => {
    expect(weaponTypeLabel(table, 'Hand Cannon', 'de')).toBe('Handfeuerwaffe');
    expect(weaponTypeLabel(table, 'Hand Cannon', 'fr')).toBe('Hand Cannon');
    expect(weaponTypeLabel(table, 'Sword', 'ja')).toBe('Sword');
    expect(weaponTypeLabel(table, 'Glaive', 'de')).toBe('Glaive');
    expect(weaponTypeLabel(undefined, 'Glaive', 'de')).toBe('Glaive');
    expect(weaponTypeLabel({ Glaive: { en: 'Glaive' } }, 'Glaive', 'en')).toBe('Glaive');
  });

  test('the schema requires English and accepts partial languages', () => {
    expect(weaponTypeLabelsSchema.safeParse(table).success).toBe(true);
    expect(weaponTypeLabelsSchema.safeParse({ Sword: { de: 'Schwert' } }).success).toBe(false);
    expect(weaponTypeLabelsSchema.safeParse({ Sword: 'Sword' }).success).toBe(false);
  });

  test('the complete table adds every default and orders keys deterministically', () => {
    const complete = completeWeaponTypeLabels({
      Sword: { fr: 'Épée', en: 'Sword', de: 'Schwert' },
      Zebra: { en: 'Zebra' },
      'Hand Cannon': { en: 'Hand Cannon' },
    });
    expect(Object.keys(complete)).toEqual([...markupWeaponTypes, 'Zebra']);
    expect(Object.keys(complete.Sword)).toEqual(['en', 'de', 'fr']);
    expect(complete.Glaive).toEqual({ en: 'Glaive' });
    expect(JSON.stringify(completeWeaponTypeLabels(completeWeaponTypeLabels(table)))).toBe(
      JSON.stringify(
        completeWeaponTypeLabels({ Sword: table.Sword, 'Hand Cannon': table['Hand Cannon'] }),
      ),
    );
    expect(JSON.stringify(completeWeaponTypeLabels())).toBe(
      JSON.stringify(englishWeaponTypeLabels),
    );
  });
});

describe('<weapons> parsing', () => {
  test('tags lines with canonical names, case-insensitively, and resolves other', () => {
    const { lines } = parseMarkup(
      'Shared.\n  <WEAPONS sword ,  hand cannon >  \nOnly these.\n</weapons>\n<weapons other>\nRest.\n</weapons>',
    );
    expect(texts(lines)).toEqual(['Shared.', 'Only these.', 'Rest.']);
    expect(lines[0].weaponTypes).toBeUndefined();
    expect(lines[1].weaponTypes).toEqual(['Sword', 'Hand Cannon']);
    expect(lines[1].weaponOther).toBeUndefined();
    expect(lines[2].weaponOther).toBe(true);
    expect(lines[2].weaponTypes).toContain('Pulse Rifle');
    expect(lines[2].weaponTypes).not.toContain('Sword');
    expect(lines[2].weaponTypes).not.toContain('Hand Cannon');
    expect(lines[1].weaponBlock).not.toBe(lines[2].weaponBlock);
  });

  test('other is the complement of every block, regardless of order', () => {
    const { lines } = parseMarkup(
      '<weapons other>\nRest.\n</weapons>\n<weapons Sniper Rifle>\nSniper.\n</weapons>',
    );
    expect(lines[0].weaponTypes).not.toContain('Sniper Rifle');
    expect(lines[0].weaponTypes).toContain('Sword');
  });

  test('tables and spacers inside a block stay in the block', () => {
    const { lines } = parseMarkup(
      '<weapons Sword>\nIntro\n\n< table wide >\n|b A | B\n| 1 | 2\n<$>\n</weapons>\nAfter',
    );
    expect(lines.map((line) => line.weaponTypes)).toEqual([
      ['Sword'],
      ['Sword'],
      ['Sword'],
      undefined,
    ]);
    expect(lines[2].table).toHaveLength(2);
  });

  test('text without tags is parsed exactly as before', () => {
    expect(parseMarkup('One\n\nTwo').lines.map((line) => line.classNames)).toEqual([
      [],
      ['spacer'],
      [],
    ]);
  });
});

describe('weapon section validation', () => {
  const messages = (text: string) => validateWeaponSections(text).map((issue) => issue.message);

  test('accepts well-formed blocks', () => {
    expect(validateWeaponSections(tagged)).toEqual([]);
  });

  test.each([
    ['unknown name', '<weapons Sword, Lazer>\nx\n</weapons>', 1, 'Unknown weapon type "Lazer"'],
    ['unclosed', 'a\n<weapons Sword>\nx', 2, 'never closed'],
    ['stray close', 'a\n</weapons>', 2, 'Stray </weapons>'],
    ['nesting', '<weapons Sword>\n<weapons Glaive>\nx\n</weapons>\n</weapons>', 2, 'nested'],
    ['empty list', '<weapons>\nx\n</weapons>', 1, 'at least one'],
    ['other with names', '<weapons other, Sword>\nx\n</weapons>', 1, 'cannot be combined'],
    [
      'second other',
      '<weapons other>\nx\n</weapons>\n<weapons other>\ny\n</weapons>',
      4,
      'Only one <weapons other>',
    ],
  ])('reports %s with its line number', (_name, text, line, fragment) => {
    const issue = validateWeaponSections(text).find((entry) => entry.message.includes(fragment));
    expect(issue?.severity).toBe('error');
    expect(issue?.line).toBe(line);
  });

  test('a nested tag produces a single error and the outer block keeps its lines', () => {
    const text = '<weapons Sword>\n<weapons Glaive>\nx\n</weapons>\n</weapons>';
    expect(validateWeaponSections(text)).toHaveLength(1);
    expect(parseMarkup(text).lines[0].weaponTypes).toEqual(['Sword']);
  });

  test('blocks with unknown names are still parsed for the known ones', () => {
    const { lines } = parseMarkup('<weapons Sword, Lazer>\nx\n</weapons>');
    expect(lines[0].weaponTypes).toEqual(['Sword']);
  });

  test('line numbers ignore comments and are reported through validateText', () => {
    const text = '/* one\ntwo */\n// note\n<weapons Nope>\nx\n</weapons>';
    expect(messages(text)).toEqual([expect.stringContaining('Unknown weapon type "Nope"')]);
    const issue = validateText(text, 'en').find((entry) => entry.message.includes('Nope'));
    expect(issue?.message.startsWith('Line 4: ')).toBe(true);
    expect(text.slice(issue?.from, issue?.to)).toBe('<weapons Nope>');
  });

  test('title declarations are separate scopes, each with its own other block', () => {
    const block = (name: string) => `<weapons other>\n${name}\n</weapons>`;
    const text = [
      'See <title A [A] /> and <title B [B] />',
      block('Main'),
      '',
      'title A (',
      block('A fallback'),
      ')',
      'title B (',
      block('B fallback'),
      ')',
    ].join('\n');
    expect(validateWeaponSections(text)).toEqual([]);
    expect(validateText(text, 'en')).toEqual([]);
    const parsed = parseMarkup(text).lines[0].linesContent?.flatMap((span) => span.title ?? []);
    expect(parsed?.map((line) => line.weaponOther)).toEqual([true, true]);
  });

  test('a duplicate other inside one title is rejected at its source line', () => {
    const text = [
      'Main',
      'title A (',
      '<weapons other>',
      'one',
      '</weapons>',
      '<weapons other>',
      'two',
      '</weapons>',
      ')',
    ].join('\n');
    expect(validateWeaponSections(text)).toEqual([
      expect.objectContaining({ line: 6, message: expect.stringContaining('Only one') }),
    ]);
    expect(
      validateText(text, 'en').filter((issue) => issue.message.startsWith('Line 6: Only one')),
    ).toHaveLength(1);
  });

  test('errors inside a title keep the original line numbers', () => {
    const text = 'Main\n\ntitle A (\nx\n<weapons Nope>\ny\n</weapons>\n)';
    expect(validateWeaponSections(text)).toEqual([
      expect.objectContaining({ line: 5, message: expect.stringContaining('"Nope"') }),
    ]);
  });

  test('the old syntax parses and warns', () => {
    const old = '< weapon type (Bow, HC) >\nBows.\n< (other) >\nRest.\n<$$>';
    const { lines } = parseMarkup(old);
    expect(lines[0].weaponTypes).toEqual(['Combat Bow', 'Hand Cannon']);
    expect(lines[1].weaponTypes).not.toContain('Combat Bow');
    expect(lines[1].weaponTypes).toContain('Sword');
    expect(hasOldWeaponTypeSyntax(old)).toBe(true);
    expect(messages(`x\n${old}`)).toEqual([expect.stringMatching(/^Old weapon-type syntax/)]);
    expect(validateWeaponSections(`x\n${old}`)[0]).toMatchObject({ severity: 'warning', line: 2 });
    expect(hasOldWeaponTypeSyntax(tagged)).toBe(false);
  });
});

describe('migrateWeaponTypeSyntax', () => {
  test('rewrites abbreviations, groups, other and tables', () => {
    const old = [
      'Shared',
      '< weapon type (Bow, HC, LMG) >',
      'First.',
      '< table wide >',
      '|b A | B',
      '| 1 | 2',
      '<$>',
      '< (AR, LFR, GL, SMG) >',
      'Second.',
      '< (Pulse, Scout, Sniper, Fusion, Rocket, Trace) >',
      'Third.',
      '< (Heavy GL, Grenade, Melee, Super, Sword, Glaive) >',
      'Fourth.',
      '< (other) >',
      'Rest.',
      '<$$>',
      'End',
    ].join('\n');
    const migrated = migrateWeaponTypeSyntax(old);
    expect(migrated).toBe(
      [
        'Shared',
        '<weapons Combat Bow, Hand Cannon, Machine Gun>',
        'First.',
        '< table wide >',
        '|b A | B',
        '| 1 | 2',
        '<$>',
        '</weapons>',
        '<weapons Auto Rifle, Linear Fusion Rifle, Grenade Launcher, Submachine Gun>',
        'Second.',
        '</weapons>',
        '<weapons Pulse Rifle, Scout Rifle, Sniper Rifle, Fusion Rifle, Rocket Launcher, Trace Rifle>',
        'Third.',
        '</weapons>',
        '<weapons Heavy Grenade Launcher, Grenade, Melee, Super, Sword, Glaive>',
        'Fourth.',
        '</weapons>',
        '<weapons other>',
        'Rest.',
        '</weapons>',
        'End',
      ].join('\n'),
    );
    expect(validateWeaponSections(migrated)).toEqual([]);
    expect(migrateWeaponTypeSyntax(migrated)).toBe(migrated);
  });

  test('migrated text parses to the same lines and tables as the old text', () => {
    const old = '< weapon type (Bow, HC) >\nA\n< table >\n|b X | Y\n<$>\n< (other) >\nB\n<$$>';
    const before = parseMarkup(old).lines;
    const after = parseMarkup(migrateWeaponTypeSyntax(old)).lines;
    const flatten = (lines: typeof before) =>
      lines.map((line) => ({
        ...line,
        weaponBlock: 0,
        weaponTypes: [...(line.weaponTypes ?? [])].sort(),
      }));
    expect(flatten(after)).toEqual(flatten(before));
  });

  test('an early old other keeps the types it covered', () => {
    const old = '< weapon type ( other ) >\nRest\n< ( Sword ) >\nSword text\n<$$>';
    const migrated = migrateWeaponTypeSyntax(old);
    expect(migrated).not.toContain('<weapons other>');
    expect(validateWeaponSections(migrated)).toEqual([]);
    const before = parseMarkup(old).lines;
    const after = parseMarkup(migrated).lines;
    for (const type of ['Sword', 'Glaive', 'Grenade']) {
      expect(texts(specializeWeaponTypes(after, { type }))).toEqual(
        texts(specializeWeaponTypes(before, { type })),
      );
    }
    expect(texts(specializeWeaponTypes(after, { type: 'Sword' }))).toEqual(['Rest', 'Sword text']);
    expect(migrateWeaponTypeSyntax(migrated)).toBe(migrated);
  });

  test('independent old chains with their own fallback stay valid and equivalent', () => {
    const old = [
      '< weapon type ( Sword ) >',
      'S1',
      '< ( other ) >',
      'R1',
      '<$$>',
      'Between',
      '< weapon type ( Glaive ) >',
      'G2',
      '< ( other ) >',
      'R2',
      '<$$>',
    ].join('\n');
    const migrated = migrateWeaponTypeSyntax(old);
    expect(validateWeaponSections(migrated)).toEqual([]);
    expect(migrated.match(/<weapons other>/g)?.length ?? 0).toBeLessThanOrEqual(1);
    const before = parseMarkup(old).lines;
    const after = parseMarkup(migrated).lines;
    for (const type of ['Sword', 'Glaive', 'Hand Cannon', 'Melee']) {
      expect(texts(specializeWeaponTypes(after, { type }))).toEqual(
        texts(specializeWeaponTypes(before, { type })),
      );
    }
  });

  test('a final old other still becomes <weapons other>', () => {
    expect(migrateWeaponTypeSyntax('< weapon type ( Sword ) >\nS\n< ( other ) >\nR\n<$$>')).toBe(
      '<weapons Sword>\nS\n</weapons>\n<weapons other>\nR\n</weapons>',
    );
  });

  test('comments on header and terminator lines are kept and do not block conversion', () => {
    const old = '< weapon type ( Sword ) > // swords\nBody\n<$$> /* end */';
    expect(hasOldWeaponTypeSyntax(old)).toBe(true);
    const migrated = migrateWeaponTypeSyntax(old);
    expect(migrated).toBe('<weapons Sword> // swords\nBody\n</weapons> /* end */');
    expect(validateWeaponSections(migrated)).toEqual([]);
    expect(migrateWeaponTypeSyntax(migrated)).toBe(migrated);
  });

  test('delimiters inside comments are not structure', () => {
    const old = [
      '< weapon type ( Sword ) >',
      '/*',
      '<$$>',
      '*/',
      'Body',
      '<$$>',
      '// < weapon type ( Glaive ) >',
    ].join('\n');
    const migrated = migrateWeaponTypeSyntax(old);
    expect(migrated).toBe(
      [
        '<weapons Sword>',
        '/*',
        '<$$>',
        '*/',
        'Body',
        '</weapons>',
        '// < weapon type ( Glaive ) >',
      ].join('\n'),
    );
    expect(validateWeaponSections(migrated)).toEqual([]);
    expect(texts(parseMarkup(migrated).lines)).toEqual(['Body']);
    expect(migrateWeaponTypeSyntax('// < weapon type ( Sword ) >\nx\n// <$$>')).toBe(
      '// < weapon type ( Sword ) >\nx\n// <$$>',
    );
  });

  test('keeps CRLF line endings and text without old blocks', () => {
    expect(migrateWeaponTypeSyntax('a\r\n< weapon type (HC) >\r\nx\r\n<$$>\r\nb')).toBe(
      'a\r\n<weapons Hand Cannon>\r\nx\r\n</weapons>\r\nb',
    );
    expect(migrateWeaponTypeSyntax('Plain\n<weapons Sword>\nx\n</weapons>')).toBe(
      'Plain\n<weapons Sword>\nx\n</weapons>',
    );
    expect(migrateWeaponTypeSyntax('< weapon type (HC) >\nunterminated')).toBe(
      '< weapon type (HC) >\nunterminated',
    );
  });
});

/** What a reader sees: every type's specialised lines, and the labelled view's text without labels. */
function views(text: string) {
  const { lines } = parseMarkup(text);
  return {
    byType: Object.fromEntries(
      markupWeaponTypes.map((type) => [type, texts(specializeWeaponTypes(lines, { type }))]),
    ),
    everything: texts(specializeWeaponTypes(lines, { labelled: {} })).map((line) =>
      line.replace(/^[^:]*: /, ''),
    ),
  };
}

describe('lossless conversion', () => {
  const allTypes = `< weapon type ( ${markupWeaponTypes.join(', ')} ) >`;
  const chain = (note: string) => [allTypes, 'All types', '< ( other ) >', note, '<$$>'];

  test('refuses hidden conditional and exported content', () => {
    const body =
      '<weapons other>\nNew fallback\n</weapons>\n< weapon type ( Sword ) >\nOld sword\n< ( other ) >\nOld fallback\n<$$>';
    for (const wrapper of [
      'enhanced',
      'catalyst',
      'exotic perk',
      'export hidden sample',
      'title sample',
    ]) {
      const old = `${wrapper} (\n${body}\n)`;
      const result = convertWeaponTypeSyntax(old);
      expect(result.text).toBe(old);
      expect(result.diagnostic).toMatch(/cannot be safely verified/);
    }
  });

  test('refuses unreferenced definitions with comment-normalised headers', () => {
    const body =
      '<weapons other>\nNew fallback\n</weapons>\n< weapon type ( Sword ) >\nOld sword\n< ( other ) >\nOld fallback\n<$$>';
    for (const header of [
      'title sample ( // note',
      'title sample ( /* note */',
      'title sample (\t',
      '/* note */title sample (',
      'export hidden sample ( // note',
      'title sample (\t// note',
      'title sample (inline',
      'enhanced (inline',
      'catalyst (inline',
      'exotic perk (inline',
      'export hidden sample (inline',
      'ti/* first */ignored/* second */tle sample (',
      '/* first */ignored/* second */title sample (',
    ]) {
      const old = `${header}\n${body}\n)`;
      const result = convertWeaponTypeSyntax(old);
      expect(result.text).toBe(old);
      expect(result.diagnostic).toMatch(/cannot be safely verified/);
    }
  });

  test.each([
    ['space', ' title sample ('],
    ['tab', '\ttitle sample ('],
    ['BOM', '\uFEFFtitle sample ('],
    ['blank line and spaces', '\n  title sample ('],
    ['variable expansion', 'var hdr = title sample (\n#hdr'],
  ])(
    'refuses %s-generated reusable content, including later table consumption',
    (_name, header) => {
      const source = `${header}\n<weapons other>\nNew fallback\n</weapons>\n< weapon type ( Sword ) >\nOld sword\n< ( other ) >\nOld fallback\n<$$>\n)`;
      const result = convertWeaponTypeSyntax(source);
      expect(result.text).toBe(source);
      expect(result.diagnostic).toMatch(/cannot be safely verified/);
      // References are deliberately added AFTER conversion: definitions are reusable even when
      // the current document never shows them. Exercise both production consumer paths.
      for (const consumer of [
        '\n<title Details [sample] />',
        '\n< table wide >\n| <title Details [sample] /> | Other\n<$>',
      ]) {
        const view = (text: string) =>
          specializeWeaponTypes(parseMarkup(text + consumer).lines, { type: 'Sword' });
        expect(JSON.stringify(view(source))).toContain('New fallback');
        expect(JSON.stringify(view(source))).toContain('Old sword');
        expect(view(result.text)).toEqual(view(source));
      }
    },
  );

  test('fails closed on unresolved evaluation and retained public export definitions', () => {
    for (const prefix of ['#unknown\n', 'export sample (inline\n']) {
      const source = `${prefix}< weapon type ( Sword ) >\nSword\n<$$>\n)`;
      const result = convertWeaponTypeSyntax(source);
      expect(result.text).toBe(source);
      expect(result.diagnostic).toMatch(/cannot be safely verified/);
    }
  });

  test.each(['// #open', '/* #open */'])(
    'refuses externally expanded variables inside %s before comment removal',
    (comment) => {
      const source = `<weapons other>\n</weapons>\n${comment}\n< weapon type ( Sword ) >\nOld sword\n/* close */\n< ( other ) >\nOld fallback\n<$$>`;
      const globals = { variables: 'var open = /*', titles: '' };
      const before = parseMarkup(source, globals);
      expect(before.diagnostics).toEqual([]);
      expect(texts(specializeWeaponTypes(before.lines, { type: 'Sword' }))).toContain(
        'Old fallback',
      );
      const result = convertWeaponTypeSyntax(source);
      expect(result.text).toBe(source);
      expect(result.diagnostic).toMatch(/variable.*cannot be safely verified/);
      const after = parseMarkup(result.text, globals);
      expect(after.diagnostics).toEqual([]);
      for (const type of markupWeaponTypes) {
        expect(specializeWeaponTypes(after.lines, { type })).toEqual(
          specializeWeaponTypes(before.lines, { type }),
        );
      }
      expect(specializeWeaponTypes(after.lines, { labelled: {} })).toEqual(
        specializeWeaponTypes(before.lines, { labelled: {} }),
      );
    },
  );

  test('refuses imports even when empty-context preparation hides them in comments', () => {
    const source = '/*\nimport main from 123\n*/\n< weapon type ( Sword ) >\nSword\n<$$>';
    const result = convertWeaponTypeSyntax(source);
    expect(result.text).toBe(source);
    expect(result.diagnostic).toMatch(/import.*cannot be safely verified/);
    const globals = { variables: '', titles: '', imports: { '123': '*/' } };
    expect(parseMarkup(result.text, globals)).toEqual(parseMarkup(source, globals));
  });

  test('refuses to delete comments embedded in either header', () => {
    for (const old of [
      '< weapon type ( Sword /* authored header note */ ) >\nSword body\n<$$>',
      '< weapon type ( Sword ) >\nSword body\n< ( other /* authored fallback note */ ) >\nOther\n<$$>',
    ]) {
      const result = convertWeaponTypeSyntax(old);
      expect(result.text).toBe(old);
      expect(result.diagnostic).toMatch(/comment/);
    }
  });

  test('refuses unknown names rather than introducing validation errors', () => {
    const old = '< weapon type (HC, Zap) >\nx\n<$$>';
    const result = convertWeaponTypeSyntax(old);
    expect(result.text).toBe(old);
    expect(result.diagnostic).toMatch(/unknown weapon type/i);
  });

  test('two fallbacks that cover no type are refused and keep their text', () => {
    const old = [...chain('Authored note A'), ...chain('Authored note B')].join('\n');
    const result = convertWeaponTypeSyntax(old);
    expect(result.text).toBe(old);
    expect(result.diagnostic).toMatch(/fallback with no remaining types/i);
    expect(migrateWeaponTypeSyntax(old)).toBe(old);
    expect(views(result.text).everything).toEqual(expect.arrayContaining(['Authored note B']));
  });

  test('a single fallback that covers no type converts and keeps its text', () => {
    const old = chain('Authored note A').join('\n');
    const result = convertWeaponTypeSyntax(old);
    expect(result.diagnostic).toBeUndefined();
    expect(result.text).toContain('<weapons other>\nAuthored note A\n</weapons>');
    expect(validateWeaponSections(result.text)).toEqual([]);
    expect(views(result.text)).toEqual(views(old));
  });

  test('an old fallback next to a new <weapons other> that would lose a type is refused', () => {
    const old = [
      '<weapons other>',
      'New fallback',
      '</weapons>',
      '< weapon type ( Sword ) >',
      'Old sword',
      '< ( other ) >',
      'Old fallback',
      '<$$>',
    ].join('\n');
    expect(views(old).byType.Sword).toEqual(['New fallback', 'Old sword']);
    const result = convertWeaponTypeSyntax(old);
    expect(result.text).toBe(old);
    expect(result.diagnostic).toMatch(/mixed old and new fallback/i);
    expect(result.diagnostic).toMatch(/rendering would change/);
  });

  test('a mixed text converts when every type still renders the same', () => {
    const old = [
      '<weapons Sword>',
      'New sword',
      '</weapons>',
      '<weapons other>',
      'New fallback',
      '</weapons>',
      '< weapon type ( Sword ) >',
      'Old sword',
      '<$$>',
    ].join('\n');
    const result = convertWeaponTypeSyntax(old);
    expect(result.diagnostic).toBeUndefined();
    expect(result.text).not.toBe(old);
    expect(validateWeaponSections(result.text)).toEqual([]);
    expect(views(result.text)).toEqual(views(old));
  });

  test('an old fallback converts to a type list beside a named new block', () => {
    const old = [
      '<weapons Glaive>',
      'New glaive',
      '</weapons>',
      '< weapon type ( Sword ) >',
      'Old sword',
      '< ( other ) >',
      'Old fallback',
      '<$$>',
    ].join('\n');
    const result = convertWeaponTypeSyntax(old);
    expect(result.diagnostic).toBeUndefined();
    expect(validateWeaponSections(result.text)).toEqual([]);
    expect(views(result.text)).toEqual(views(old));
    expect(views(result.text).byType.Glaive).toEqual(['New glaive', 'Old fallback']);
  });

  test('a multiline comment after the terminator moves to its own line and renders the same', () => {
    const old = '< weapon type ( Sword ) >\nSword body\n<$$> /* note\ncontinued */\nAfter';
    const result = convertWeaponTypeSyntax(old);
    expect(result.diagnostic).toBeUndefined();
    expect(result.text).toBe(
      '<weapons Sword>\nSword body\n</weapons>\n/* note\ncontinued */\nAfter',
    );
    expect(views(old).byType.Sword).toEqual(['Sword body', 'After']);
    expect(views(result.text).byType.Sword).toEqual(['Sword body', 'After']);
    expect(views(result.text)).toEqual(views(old));
    expect(views(result.text).everything.join('\n')).not.toContain('</weapons>');
    expect(validateWeaponSections(result.text)).toEqual([]);
    expect(migrateWeaponTypeSyntax(result.text)).toBe(result.text);
  });

  test('a comment after a header or terminator that does not join lines stays in place', () => {
    const old = '< weapon type ( Sword ) > // swords\nBody\n<$$> // end\nAfter';
    const result = convertWeaponTypeSyntax(old);
    expect(result.text).toBe('<weapons Sword> // swords\nBody\n</weapons> // end\nAfter');
    expect(views(result.text)).toEqual(views(old));
  });

  test('any conversion renders the same, otherwise the text is left with a diagnostic', () => {
    const cases = [
      '< weapon type ( Sword ) > /* a\nb */\nBody\n<$$>\nAfter',
      'Intro\n< weapon type ( Sword ) >\nS\n< ( other ) >\nR\n<$$> /* end */\nAfter',
      '< weapon type ( Bow ) > /* x */\nB\n<$$>\nTail',
    ];
    for (const old of cases) {
      const result = convertWeaponTypeSyntax(old);
      if (result.text === old) expect(result.diagnostic).toBeTruthy();
      else expect(views(result.text)).toEqual(views(old));
    }
  });

  test('text without a complete old block is reported, not silently ignored', () => {
    const old = '< weapon type (HC) >\nunterminated';
    const result = convertWeaponTypeSyntax(old);
    expect(result.text).toBe(old);
    expect(result.diagnostic).toMatch(/no complete old block/i);
    expect(convertWeaponTypeSyntax('Plain\n<weapons Sword>\nx\n</weapons>')).toEqual({
      text: 'Plain\n<weapons Sword>\nx\n</weapons>',
    });
  });
});

describe('specializeWeaponTypes', () => {
  const { lines } = parseMarkup(tagged);

  test('a type keeps shared lines and its own sections, untagged', () => {
    const swords = specializeWeaponTypes(lines, { type: 'Sword' });
    expect(texts(swords)).toEqual(['Shared.', 'Melee and cannons.']);
    expect(swords.every((line) => line.weaponTypes === undefined)).toBe(true);
    expect(texts(specializeWeaponTypes(lines, { type: 'Pulse Rifle' }))).toEqual([
      'Shared.',
      'Everything else.',
    ]);
  });

  test('labelled keeps every section and prefixes each block once', () => {
    const labelled = specializeWeaponTypes(lines, {
      labelled: {},
      among: ['Sword', 'Pulse Rifle'],
    });
    expect(texts(labelled)).toEqual([
      'Shared.',
      'Sword: Melee and cannons.',
      'Pulse Rifle: Everything else.',
    ]);
    expect(labelled.every((line) => line.weaponTypes === undefined)).toBe(true);
  });

  test('labelled uses custom labels, joins multi-type blocks and labels other without among', () => {
    const labelled = specializeWeaponTypes(lines, {
      labelled: { Sword: { en: 'Sword', de: 'Schwert' } },
    });
    expect(texts(labelled)).toEqual([
      'Shared.',
      'Sword, Hand Cannon: Melee and cannons.',
      'Other: Everything else.',
    ]);
  });

  test('labelled resolves labels for the language with English fallback', () => {
    const labels = {
      Sword: { en: 'Sword', de: 'Schwert' },
      'Pulse Rifle': { en: 'Pulse Rifle' },
    };
    const german = specializeWeaponTypes(lines, {
      labelled: labels,
      language: 'de',
      among: ['Sword', 'Pulse Rifle'],
    });
    expect(texts(german)).toEqual([
      'Shared.',
      'Schwert: Melee and cannons.',
      'Pulse Rifle: Everything else.',
    ]);
    expect(
      texts(
        specializeWeaponTypes(lines, {
          labelled: { other: { en: 'Other', de: 'Übrige' } },
          language: 'de',
        }),
      ),
    ).toEqual(['Shared.', 'Sword, Hand Cannon: Melee and cannons.', 'Übrige: Everything else.']);
  });

  test('labelled prefixes only the first line and adds a label line before a table', () => {
    const parsed = parseMarkup(
      '<weapons Sword>\nOne\nTwo\n</weapons>\n<weapons Glaive>\n< table >\n|b A | B\n<$>\n</weapons>',
    ).lines;
    const labelled = specializeWeaponTypes(parsed, { labelled: {} });
    expect(texts(labelled)).toEqual(['Sword: One', 'Two', 'Glaive:', '[table]']);
  });

  test('specialises titles nested in lines', () => {
    const parsed = parseMarkup(
      'See <title Tip [Tip] />\n\ntitle Tip (\n<weapons Sword>\nS\n</weapons>\n<weapons Glaive>\nG\n</weapons>\n)',
    ).lines;
    const nested = specializeWeaponTypes(parsed, { type: 'Sword' })[0].linesContent?.[1].title;
    expect(texts(nested ?? [])).toEqual(['S']);
  });
});
