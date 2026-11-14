import { describe, expect, it } from 'vitest';
import { applyGlossary } from './apply.js';
import { compileTerms, matchTerms } from './match.js';
import { glossaryProse, glossaryTermUsed } from './prose.js';
import { emptyGlossary, glossaryInputSchema, glossaryKey, glossarySchema } from './schema.js';

const date = '2026-11-14T12:00:00.000Z';
const entry = { en: 'Jolt', term: 'Aufschrecken', updatedAt: date, updatedBy: 'alice' };
describe('glossary storage and CAS', () => {
  it('normalizes keys, enforces strict schemas, limits, and rejects dangerous keys', () => {
    expect(glossaryKey('  ＪＯＬＴ \n Weapon ')).toBe('jolt weapon');
    expect(
      glossarySchema.safeParse({ ...emptyGlossary('de'), terms: { wrong: entry } }).success,
    ).toBe(false);
    expect(glossarySchema.safeParse({ ...emptyGlossary('de'), lang: 'en' }).success).toBe(false);
    for (const next of [
      { ...entry, note: 'x'.repeat(241) },
      { ...entry, forms: Array(9).fill('x') },
      { ...entry, extra: true },
    ])
      expect(
        glossaryInputSchema.safeParse({ ops: [{ key: 'jolt', base: null, next }] }).success,
      ).toBe(false);
    expect(
      glossaryInputSchema.safeParse({ ops: [{ key: 'constructor', base: null, next: null }] })
        .success,
    ).toBe(false);
    expect(
      glossaryInputSchema.safeParse({
        ops: Array(2).fill({ key: 'jolt', base: null, next: entry }),
      }).success,
    ).toBe(false);
    const terms = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [`term ${i}`, { ...entry, en: `Term ${i}` }]),
    );
    expect(glossarySchema.safeParse({ ...emptyGlossary('de'), terms }).success).toBe(false);
  });
  it('merges independent edits, stamps on the server, and rejects a whole conflicted batch', () => {
    const a = applyGlossary(
      emptyGlossary('de'),
      [{ key: 'jolt', base: null, next: { ...entry, updatedBy: 'forged' } }],
      date,
      'bob',
    );
    expect(a.glossary.terms.jolt.updatedBy).toBe('bob');
    const b = applyGlossary(
      a.glossary,
      [{ key: 'stun', base: null, next: { en: 'Stun', term: 'Betäuben' } }],
      date,
      'carol',
    );
    expect(Object.keys(b.glossary.terms)).toEqual(['jolt', 'stun']);
    const failed = applyGlossary(
      b.glossary,
      [
        { key: 'jolt', base: null, next: entry },
        { key: 'stun', base: b.glossary.terms.stun, next: null },
      ],
      date,
      'alice',
    );
    expect(failed.conflicts).toEqual([{ key: 'jolt', head: a.glossary.terms.jolt }]);
    expect(failed.glossary).toBe(b.glossary);
  });
});
describe('glossary matching', () => {
  it('matches automatic forms, aliases, longest first, any case, and Unicode word boundaries', () => {
    const compiled = compileTerms([
      { en: 'Jolt' },
      { en: 'Ignite' },
      { en: 'Stun' },
      { en: 'Carry' },
      { en: 'Weapon Kill' },
      { en: 'Kill' },
      { en: 'Freeze', also: ['Frozen'] },
    ]);
    const source =
      'jolt JOLTS joltes jolted jolting Ignited Igniting Stuns Stunned Stunning Carries Carried Weapon-Kills Frozen';
    const matches = matchTerms(source, compiled);
    expect(matches.map((m) => source.slice(m.from, m.to))).toEqual(source.split(' '));
    expect(
      matchTerms(
        'several slower Shatterdive Devourer Joltedness αJolt Joltα',
        compileTerms([
          { en: 'Sever' },
          { en: 'Slow' },
          { en: 'Shatter' },
          { en: 'Devour' },
          { en: 'Jolt' },
        ]),
      ),
    ).toEqual([]);
    expect(matchTerms('Jolt jolt', compileTerms([{ en: 'Jolt', matchCase: true }]))).toHaveLength(
      1,
    );
  });
  it('uses core markup ranges to exclude comments, tags, variables, maths, numbers, and structure', () => {
    const source =
      'var Jolt = Jolt\nimport Jolt from 1\nexport Jolt (\nJolt <bold Jolt /> <Jolt/> #Jolt #{Jolt} ${Jolt} 123 // Jolt\n/* Jolt */\n)';
    const found = matchTerms(
      glossaryProse(source),
      compileTerms([{ en: 'Jolt' }, { en: 'bold' }, { en: '123' }]),
    );
    expect(found.map((m) => source.slice(m.from, m.to))).toEqual(['Jolt', 'Jolt']);
    expect(
      matchTerms(glossaryProse('Weapon<bold Kill />'), compileTerms([{ en: 'Weapon Kill' }])),
    ).toEqual([]);
    const pvp = '<pvp [Slow x50] />';
    expect(matchTerms(glossaryProse(pvp), compileTerms([{ en: 'Slow' }]))).toEqual([
      { from: 6, to: 10, entry: 0 },
    ]);
  });
  it('checks normalized translated substrings and accepted forms only in readable text', () => {
    expect(
      glossaryTermUsed(glossaryProse('AUFGESCHRECKTE Gegner'), {
        ...entry,
        forms: ['aufgeschreckt'],
      }),
    ).toBe(true);
    expect(glossaryTermUsed(glossaryProse('#Aufschrecken // Aufschrecken'), entry)).toBe(false);
    expect(glossaryTermUsed('電撃状態', { term: '電撃' })).toBe(true);
  });
});
