import { expect, test } from 'vitest';
import { parseMarkup, validateText, weaponSectionHeadings } from '../src/index.js';

const texts = (text: string) =>
  parseMarkup(text).lines.flatMap((line) => line.linesContent?.map((span) => span.text) ?? []);

test('both retired syntaxes retain all bodies, including repeated fallbacks and unknown names', () => {
  const text =
    '< weapon type (Bow, HC) >\nBow body\n< (other) >\nFallback\n<$$>\n<weapons Unrecognized>\nUnknown body\n</weapons>\n<weapons other>\nAnother fallback\n</weapons>';
  expect(texts(text).filter(Boolean)).toEqual([
    'Combat Bow, Hand Cannon',
    'Bow body',
    'Other weapons',
    'Fallback',
    'Unrecognized',
    'Unknown body',
    'Other weapons',
    'Another fallback',
  ]);
  expect(validateText(text, 'en')).toEqual([]);
  const lines = JSON.stringify(parseMarkup(text).lines);
  for (const key of ['weaponTypes', 'weaponBlock', 'weaponOther']) expect(lines).not.toContain(key);
});

test('nested blocks, empty and unclosed blocks never discard a body', () => {
  const text =
    '<weapons Sword>\nOuter\n<weapons Glaive>\nInner\n</weapons>\nTail\n</weapons>\n<weapons other>\n</weapons>\n<weapons Future>\nUnclosed';
  expect(texts(text).filter(Boolean)).toEqual([
    'Sword',
    'Outer',
    'Glaive',
    'Inner',
    'Tail',
    'Other weapons',
    'Future',
    'Unclosed',
  ]);
});

test('imported globals, variables, conditionals and title tables keep ordinary parsing', () => {
  const result = parseMarkup(
    'import Shared from global\n<title Details [Info] />\nenhanced (\n<weapons other>\nEnhanced\n</weapons>\n)',
    {
      variables: 'var amount = 25',
      titles:
        'title Info (\n< weapon type (HC) >\n< table wide >\n| #amount\n<$>\n< (other) >\nTitle fallback\n<$$>\n)',
      imports: { 1: 'export hidden Shared (\n<weapons Sword>\nImported #amount\n</weapons>\n)' },
      type: 'Weapon Trait Enhanced',
    },
  );
  const json = JSON.stringify(result);
  for (const value of ['Imported 25', 'Enhanced', 'Hand Cannon', 'Title fallback', 'table', '25'])
    expect(json).toContain(value);
  expect(result.diagnostics).toEqual([]);
  expect(parseMarkup('enhanced (\n<weapons Sword>\nEnhanced\n</weapons>\n)').lines).toEqual([]);
});

test('comments do not produce visible headings', () => {
  expect(texts('/*\n<weapons Sword>\nHidden\n</weapons>\n*/\nVisible')).toEqual(['Visible']);
});

test('plain heading proposal is idempotent and keeps every non-delimiter line', () => {
  const source = '< weapon type (HC) >\n<bold Body />\n< (other) >\nFallback\n<$$>';
  const proposed = weaponSectionHeadings(source);
  expect(proposed).toBe('<bold Hand Cannon />\n<bold Body />\n<bold Other weapons />\nFallback\n');
  expect(weaponSectionHeadings(proposed)).toBe(proposed);
});

test('unknown names cannot inherit abbreviation-map properties', () => {
  expect(texts('<weapons constructor, __proto__>\nBody\n</weapons>').filter(Boolean)).toEqual([
    'constructor, __proto__',
    'Body',
  ]);
});
