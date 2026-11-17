import { expect, test } from 'vitest';
import { fixAllRetired, lowerConsumerMarkup, parseMarkup } from '@clarity/core';
import {
  buildLegacy,
  compile,
  deployedLegacyPresets,
  newStyleFile,
  styles,
  type LegacyInput,
} from '../src/index.js';

const input = (text: string): LegacyInput => {
  const perk = (hash: number, main: string): LegacyInput['perks'][string] => ({
    hash,
    name: 'Probe',
    type: 'Weapon Trait',
    uploadedBy: 'test',
    lastUpload: 1,
    updateTracker: { descriptions: {} },
    inLiveDatabase: true,
    uploadToLive: true,
    editor: { en: { main, secondary: '' } },
  });
  return { perks: { 1: perk(1, ''), 2: perk(2, ''), 3: perk(3, ''), 100: perk(100, text) } };
};
const catalog = { items: { 100: { categoryId: 'all' } }, categories: [{ id: 'all' }] };

test.each([
  '<yel/* keep */low Gjallarhorn />',
  '<yellow/* keep */ Gjallarhorn />',
  '<yel/* keep */low/>Line',
  '<yellow/* keep *//>Line',
  '<yel\rlow Gjallarhorn />',
  'var Name = <yel/* keep */low Gjallarhorn />\n#Name',
  'title Name (\n<yel/* keep */low Gjallarhorn />\n)\n<title See [Name] />',
])('keyword migration preserves parser and every consumer with comments: %s', (before) => {
  const after = fixAllRetired(before).text;
  expect(after).not.toBe(before);
  if (before.includes('/* keep */')) expect(after).toContain('/* keep */');
  expect(parseMarkup(after)).toEqual(parseMarkup(before));
  expect(lowerConsumerMarkup(lowerConsumerMarkup(after))).toBe(lowerConsumerMarkup(after));
  for (const preset of deployedLegacyPresets)
    expect(buildLegacy(input(after), preset), preset).toEqual(buildLegacy(input(before), preset));
  for (const style of styles) {
    const config = newStyleFile('parity', style);
    config.data.categories = ['all'];
    expect(compile(input(after), config, { catalog }).bytes, style).toEqual(
      compile(input(before), config, { catalog }).bytes,
    );
  }
});

test('lowering keeps Exotic words inside comments unchanged', () => {
  const source = '/* <exotic comment /> */\n<exotic Gjallarhorn /> // <exotic note />';
  expect(lowerConsumerMarkup(source)).toBe(
    '/* <exotic comment /> */\n<yellow Gjallarhorn /> // <exotic note />',
  );
});
