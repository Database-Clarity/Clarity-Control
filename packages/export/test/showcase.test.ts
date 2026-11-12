import { expect, test } from 'vitest';
import { showcaseId } from '@clarity/core/markup/showcase';
import {
  compile,
  decodeV1,
  deployedLegacyPresets,
  legacyPresets,
  newStyleFile,
  styles,
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
