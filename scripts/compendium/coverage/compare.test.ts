import { describe, expect, test } from 'vitest';
import { compareSheet, discoverTabs, expectedCsvRows, isIncludedTab } from './compare.js';

describe('independent CSV coverage', () => {
  test('only literal uppercase OLD excludes tabs', () => {
    expect(
      ['OLD Armor Mods', 'prefixOLDsuffix', 'Old Armor Mods', 'old data', 'Golden'].map(
        isIncludedTab,
      ),
    ).toEqual([false, false, true, true, true]);
  });
  test('discovers raw Landing inventory independently and rejects missing/malformed tabs', () => {
    const landing =
      'items.push({name:"OLD Archive",gid:"1"});items.push({name:"Old Kept",gid:"2"});';
    const tabs = discoverTabs(landing);
    expect(tabs).toHaveLength(2);
    expect(tabs.filter((tab) => isIncludedTab(tab.name))).toEqual([{ name: 'Old Kept', gid: '2' }]);
    expect(() => discoverTabs('no tabs')).toThrow();
    expect(() => discoverTabs('items.push({name:"",gid:"1"})')).toThrow();
  });
  test('quoted commas, escaped quotes, embedded newlines and continuation rows', () => {
    const rows = expectedCsvRows(
      'Name,Description\r\n"A, B","First ""quote""\nline"\r\n,Continuation\r\n',
    );
    expect(rows).toEqual([{ name: 'A, B', text: 'First "quote"\nline\nContinuation', csvRow: 2 }]);
    expect(
      compareSheet(rows, [
        {
          name: ' A, B ',
          cell: { plain: 'First "quote" line  Continuation' },
          rowIndex: 9,
        },
      ]).mismatches,
    ).toEqual([]);
  });
  test('malformed, empty, unrecognized and missing data fail closed', () => {
    for (const csv of [
      '',
      'Name,Description\n"A,broken',
      'Name,Description\nA,"closed"bad',
      'X,Y\nA,B',
      'Name,Description',
    ]) {
      expect(() => expectedCsvRows(csv)).toThrow();
    }
  });
  test('reports missing rows and all text differences without sanitizing punctuation', () => {
    const rows = expectedCsvRows('Name,Description\nA,one\nB,two');
    expect(
      compareSheet(rows, [{ name: 'A', cell: { plain: 'one!' }, rowIndex: 5 }]).mismatches,
    ).toEqual([
      { kind: 'text', name: 'A', csvRow: 2, parsedRow: 5, expected: 'one', actual: 'one!' },
      { kind: 'missing', name: 'B', csvRow: 3, expected: 'two' },
    ]);
  });
  test('duplicate names match independently and extra duplicates are not hidden', () => {
    const rows = expectedCsvRows('Name,Description\nA,one\nA,two');
    const parsed = ['two', 'one', 'extra'].map((plain) => ({
      name: 'A',
      cell: { plain },
      rowIndex: 3,
    }));
    expect(compareSheet(rows, parsed).mismatches).toEqual([
      { kind: 'unexpected', name: 'A', parsedRow: 3, actual: 'extra' },
    ]);
  });
  test('parallel groups and card descriptions come directly from CSV', () => {
    expect(expectedCsvRows('Name,Description,Name,Description\nA,first,B,second')).toHaveLength(2);
    expect(
      expectedCsvRows(',A,,B\nfirst,,,second', {
        name: 'Cards',
        cards: true,
        groups: [
          { nameColumns: [1], descriptionColumns: [0] },
          { nameColumns: [3], descriptionColumns: [3] },
        ],
      }),
    ).toEqual([
      { name: 'A', text: 'first', csvRow: 1 },
      { name: 'B', text: 'second', csvRow: 1 },
    ]);
  });
  test('Landing alone is explicitly navigation-only', () => {
    expect(expectedCsvRows('welcome', { name: 'Landing', navigationOnly: true })).toEqual([]);
  });
  test('full multiline names and every successive description column are retained', () => {
    const config = {
      name: 'Subclass',
      nameHeaders: ['Fragments'],
      descriptionHeaders: ['Information', 'Stat Changes'],
    };
    expect(
      expectedCsvRows('Fragments,Information,Stat Changes\n"A\nB",Damage,+10', config),
    ).toEqual([{ name: 'A\nB', text: 'Damage\n+10', csvRow: 2 }]);
  });
  test('season headings cannot consume the next card title as a description', () => {
    expect(
      expectedCsvRows(',Season of the Wish\n,A\n,Description', {
        name: 'Cards',
        cards: true,
        groups: [{ nameColumns: [1], descriptionColumns: [1] }],
      }),
    ).toEqual([{ name: 'A', text: 'Description', csvRow: 2 }]);
  });
  test('parallel alias names share CSV merged Notes without counting a section as a name', () => {
    expect(
      expectedCsvRows('Armor,Notes,Armor,Notes\nA,one,B,two\nAlias A,,Alias B,\nAeon Sects,,,', {
        name: 'Exotic Armors',
        descriptionHeaders: ['Notes'],
      }),
    ).toEqual([
      { name: 'A', text: 'one', csvRow: 2 },
      { name: 'B', text: 'two', csvRow: 2 },
      { name: 'Alias A', text: 'one', csvRow: 3 },
      { name: 'Alias B', text: 'two', csvRow: 3 },
    ]);
  });
  test('grenade enhancement inherits only the CSV base grenade cooldown, not arbitrary stats', () => {
    const config = {
      name: 'Arc',
      descriptionHeaders: ['Information', 'Stat Changes'],
    };
    expect(
      expectedCsvRows(
        'Name,Information,Stat Changes\nFlashbang,Base,Base Cooldown: 131 seconds\nTouch of Thunder,Enhanced,\nOther,Separate,',
        config,
      ).map((row) => row.text),
    ).toEqual([
      'Base\nBase Cooldown: 131 seconds',
      'Enhanced\nBase Cooldown: 131 seconds',
      'Separate',
    ]);
  });
});
