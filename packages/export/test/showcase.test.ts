import { expect, test } from 'vitest';
import { showcaseGlobals, showcaseId, showcaseText } from '@clarity/core/markup/showcase';
import {
  compile,
  decodeV1,
  deployedLegacyPresets,
  legacyPresets,
  newStyleFile,
  styles,
  type LegacyInput,
} from '../src/index.js';
import { dataSchema, fileSchema } from '../src/config.js';
import { fixtureInput } from './helpers.js';

const input = fixtureInput().input;
const catalog = { items: {}, categories: [] };

test('absent setting stays absent, and new files are off', () => {
  const file = newStyleFile('example', 'structured');
  expect(file.data.includeShowcase).toBeUndefined();
  expect(dataSchema.parse(file.data)).not.toHaveProperty('includeShowcase');
  expect(dataSchema.safeParse({ ...file.data, includeShowcase: 'true' }).success).toBe(false);
});

for (const style of styles) {
  test(`${style}: showcase and a normal row compile identical descriptions`, () => {
    const perk = (hash: number, main: string): LegacyInput['perks'][string] => ({
      hash,
      name: 'Example',
      type: 'Weapon Trait Enhanced',
      uploadedBy: 'test',
      lastUpload: 1,
      updateTracker: { descriptions: {} },
      inLiveDatabase: true,
      uploadToLive: true,
      editor: { en: { main, secondary: '' } },
    });
    const sameText: LegacyInput = {
      perks: {
        1: perk(1, ''),
        2: perk(2, showcaseGlobals.variables),
        3: perk(3, showcaseGlobals.titles),
        100: perk(100, showcaseText),
      },
    };
    const file = newStyleFile('example', style);
    file.data.categories = ['example'];
    file.data.includeShowcase = true;
    const plan = compile(sameText, file, {
      catalog: {
        items: { 100: { categoryId: 'example' } },
        categories: [{ id: 'example' }],
      },
    });
    expect(Object.keys(plan.expanded!)).toEqual(['100', showcaseId]);
    expect(plan.expanded![showcaseId].descriptions).toEqual(plan.expanded!['100'].descriptions);
  });
  test(`${style}: opt-in adds exactly one reserved entry, with fixed output bytes`, async () => {
    const file = newStyleFile('example', style);
    const before = compile(input, file, { catalog });
    const off = compile(
      input,
      { ...file, data: { ...file.data, includeShowcase: false } },
      { catalog },
    );
    expect(off.bytes).toEqual(before.bytes);
    const on = compile(
      input,
      { ...file, data: { ...file.data, includeShowcase: true } },
      { catalog },
    );
    expect(Object.keys(on.expanded!)).toEqual([showcaseId]);
    expect(decodeV1(on.file!)).toEqual(on.expanded);
    expect(Number(showcaseId)).toBeLessThan(0);
    await expect(new TextDecoder().decode(on.bytes)).toMatchFileSnapshot(
      `./fixtures/showcase-${style}.json`,
    );
  });
}

test('the seven frozen legacy file configs cannot opt in', () => {
  expect(deployedLegacyPresets).toHaveLength(7);
  for (const preset of legacyPresets) {
    const file = { id: 'legacy', preset, formatVersion: 1 };
    expect(fileSchema.safeParse({ ...file, data: { includeShowcase: true } }).success).toBe(false);
    const plan = compile(input, fileSchema.parse(file), { catalog });
    expect(new TextDecoder().decode(plan.bytes)).not.toContain('Feature showcase');
    expect(JSON.parse(new TextDecoder().decode(plan.bytes))).not.toHaveProperty(showcaseId);
  }
});
