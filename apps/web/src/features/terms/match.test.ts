import { describe, expect, it } from 'vitest';
import { compileTerms, englishEndings, matchTerms, type TermEntry } from './match';
import { createTermsHandler } from './termsRequest';
import { buildTermList } from './termList';
import type { NamesFile } from './names';
import type { Item } from '../../services/generator';

const found = (text: string, entries: TermEntry[]) =>
  matchTerms(text, compileTerms(entries)).map(
    (match) => `${text.slice(match.from, match.to)}=${entries[match.entry]!.en}`,
  );

describe('englishEndings', () => {
  it.each([
    ['Jolt', ['jolt', 'jolts', 'jolted', 'jolting']],
    ['Ignite', ['ignited', 'igniting']],
    ['Stun', ['stunned', 'stunning']],
    ['Ally', ['allies', 'allied']],
  ])('%s', (word, forms) => {
    const endings = englishEndings(word);
    for (const form of forms) expect(endings.has(form)).toBe(true);
  });
});

describe('matchTerms', () => {
  it.each<[string, string, TermEntry[], string[]]>([
    [
      'whole words, any case for keywords',
      'Jolt targets; jolted foes.',
      [{ en: 'Jolt' }],
      ['Jolt=Jolt', 'jolted=Jolt'],
    ],
    ['possessive keeps the word', "Jolt's chain", [{ en: 'Jolt' }], ['Jolt=Jolt']],
    ['not inside longer words', 'Joltage and Shatterdive', [{ en: 'Jolt' }, { en: 'Shatter' }], []],
    [
      'longest term first',
      'Kinetic Tremors hit',
      [{ en: 'Kinetic' }, { en: 'Kinetic Tremors' }],
      ['Kinetic Tremors=Kinetic Tremors'],
    ],
    [
      'words joined by a space or a hyphen only',
      'Kinetic-Tremors; Kinetic  Tremors',
      [{ en: 'Kinetic Tremors' }],
      ['Kinetic-Tremors=Kinetic Tremors'],
    ],
    [
      'case-sensitive names',
      'Voltshot fires; a voltshot',
      [{ en: 'Voltshot', matchCase: true }],
      ['Voltshot=Voltshot'],
    ],
    ['also forms', 'Frozen targets', [{ en: 'Freeze', also: ['Frozen'] }], ['Frozen=Freeze']],
    ['separate lines never join', 'Kinetic\nTremors', [{ en: 'Kinetic Tremors' }], []],
  ])('%s', (_name, text, entries, expected) => {
    expect(found(text, entries)).toEqual(expected);
  });
});

describe('createTermsHandler', () => {
  it('compiles a list once and then answers by id', () => {
    const handle = createTermsHandler();
    expect(handle({ listId: 'a', text: 'Jolt' })).toEqual({ unknownList: true });
    expect(handle({ listId: 'a', entries: [{ en: 'Jolt' }], text: 'Jolt' })).toEqual({
      matches: [{ from: 0, to: 4, entry: 0 }],
    });
    expect(handle({ listId: 'a', text: 'a Jolt' })).toEqual({
      matches: [{ from: 2, to: 6, entry: 0 }],
    });
  });
});

describe('buildTermList', () => {
  const item = (hash: number, name: string, extra: Partial<Item> = {}): Item => ({
    hash,
    name,
    icon: '',
    categoryId: 'weapon-trait',
    inGameDescription: '',
    definitionType: 'DestinyInventoryItemDefinition',
    ...extra,
  });
  const items: Record<string, Item> = {
    1: item(1, 'Voltshot'),
    2: item(2, 'Voltshot'),
    3: item(3, 'Jolted', { definitionType: 'DestinyTraitDefinition', categoryId: 'verbs' }),
    4: item(4, 'Arc'),
    5: item(5, 'Hidden Perk', { hiddenFromEditor: true }),
    6: item(6, 'Catalyst Perk', { itemHash: 60, itemName: 'Ace of Spades' }),
    7: item(7, 'Two Piece', { setHash: 70, setName: 'Techsec Set' }),
    8: item(8, 'No Name Here'),
  };
  const file: NamesFile = {
    v: 1,
    lang: 'de',
    manifestVersion: 'm1',
    names: {
      1: 'Voltschuss',
      2: 'Voltschuss',
      3: 'Aufgeschreckt',
      4: 'Arkus',
      5: 'Versteckt',
      6: 'Katalysator',
      7: 'Zweiteilig',
    },
    itemNames: { 60: 'Pik-Ass' },
    setNames: { 70: 'Techsec-Set' },
  };
  const list = buildTermList(items, file, 'de');
  it('pairs English names with the official names and skips short, hidden, and unnamed items', () => {
    expect(list.terms.map((term) => [term.en, term.kind, term.official])).toEqual([
      ['Ace of Spades', 'name', ['Pik-Ass']],
      ['Catalyst Perk', 'name', ['Katalysator']],
      ['Jolted', 'keyword', ['Aufgeschreckt']],
      ['Techsec Set', 'name', ['Techsec-Set']],
      ['Two Piece', 'name', ['Zweiteilig']],
      ['Voltshot', 'name', ['Voltschuss']],
    ]);
    expect(list.terms.find((term) => term.en === 'Jolted')?.matchCase).toBe(false);
    expect(list.terms.find((term) => term.en === 'Voltshot')?.matchCase).toBe(true);
  });
  it('is built once per names file and catalogue', () => {
    expect(buildTermList(items, file, 'de')).toBe(list);
  });
});
