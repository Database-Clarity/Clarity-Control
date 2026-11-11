import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildAllLegacy,
  buildLegacy,
  deployedLegacyPresets,
  legacyFileName,
  legacyPresets,
  nextVersions,
  type LegacyInput,
  type LegacyPreset,
} from '../src/index.js';
import { doMath } from '../src/converter/converterFunctions/math.js';
import { cleanObject, customJsonStringify, pick } from '../src/converter/helpers.js';

const decoder = new TextDecoder();
const perk = (hash: number, main: string, secondary = main, extra = {}) => ({
  hash,
  name: `Perk ${hash}`,
  type: 'Weapon Perk' as const,
  uploadedBy: 'test',
  lastUpload: 1,
  updateTracker: { descriptions: {} },
  editor: { en: { main, secondary } },
  inLiveDatabase: true,
  uploadToLive: true,
  ...extra,
});
const base = { 1: perk(1, ''), 2: perk(2, ''), 3: perk(3, ''), 100: perk(100, 'Plain text') };

// Perk 200 imports an export that only 300's main text has. Presets that write the main text
// (clarity, braytech, clarityV2) import from the secondary text, so only they fail.
const importFailure: LegacyInput = {
  perks: {
    ...base,
    200: perk(200, 'import X from 300\nUses X'),
    300: perk(300, 'export X (\nfrom main\n)\nBody', 'Body'),
  },
};
// clarityV2 is the only preset that outputs `associated`; its target is left out as Bungie-identical.
const associationFailure: LegacyInput = {
  perks: {
    ...base,
    400: perk(400, 'Has a link', 'Has a link', { associated: [500] }),
    500: perk(500, 'Bungie'),
  },
};

describe('per-file isolation (spec section 3, "Legacy files")', () => {
  test('a preset that fails does not stop the others, and versions.json is still bumped', () => {
    const build = buildAllLegacy(importFailure, { descriptions: 2.0625 });
    expect(build.files.map((file) => [file.name, file.ok])).toEqual([
      ['clarity.json', false],
      ['dim.json', true],
      ['crayon.json', true],
      ['foundry.json', true],
      ['lightGG.json', true],
      ['braytech.json', false],
      ['vaultZero.json', true],
    ]);
    const failed = build.files.find((file) => file.preset === 'clarity');
    expect(failed?.ok === false && failed.error.message).toBe(
      'Missing export X from 300 for 200/en',
    );
    expect(decoder.decode(build.versions.bytes)).toBe('{\n "descriptions": 2.0626\n}');
    for (const file of build.files) {
      if (!file.ok) continue;
      expect(file.bytes).toEqual(buildLegacy(importFailure, file.preset));
      expect(decoder.decode(file.bytes)).toContain('from main');
    }
  });

  test('a failure in one preset of all eight, and an unknown preset, stay in their own result', () => {
    const presets = [...legacyPresets, 'unknown' as LegacyPreset];
    const build = buildAllLegacy(
      associationFailure,
      { descriptions: 1 },
      {
        presets,
        identical: [500],
      },
    );
    expect(build.files.filter((file) => !file.ok).map((file) => file.preset)).toEqual([
      'clarityV2',
      'unknown',
    ]);
    expect(build.files.filter((file) => file.ok)).toHaveLength(7);
    const v2 = build.files.find((file) => file.preset === 'clarityV2');
    expect(v2?.ok === false && v2.error.message).toMatch(/^Invalid output reference 400 -> 500/);
    expect(() => buildLegacy(associationFailure, 'unknown' as LegacyPreset)).toThrow(
      'Unknown legacy preset: unknown',
    );
  });

  test('an input that is invalid for every preset fails every file but still returns', () => {
    const build = buildAllLegacy({ perks: { 100: perk(100, 'No globals') } }, { descriptions: 3 });
    expect(build.files.every((file) => !file.ok)).toBe(true);
    expect(build.versions.value.descriptions).toBe(3.0001);
  });
});

describe('engine API', () => {
  test('presets and exact-case file names', () => {
    expect(legacyPresets).toHaveLength(8);
    expect(deployedLegacyPresets).not.toContain('clarityV2');
    expect(deployedLegacyPresets.map(legacyFileName)).toEqual([
      'clarity.json',
      'dim.json',
      'crayon.json',
      'foundry.json',
      'lightGG.json',
      'braytech.json',
      'vaultZero.json',
    ]);
  });

  test('versions.json keeps the +0.0001 rule, other keys, and the held formatting', () => {
    expect(nextVersions({ descriptions: 2.0625 }).value.descriptions).toBe(2.0626);
    expect(nextVersions({ descriptions: 2.0999 }).value.descriptions).toBe(2.1);
    expect(nextVersions({ descriptions: 0.1 + 0.2 }).value.descriptions).toBe(0.3001);
    expect(decoder.decode(nextVersions({ other: 'kept', descriptions: 1 }).bytes)).toBe(
      '{\n "other": "kept",\n "descriptions": 1.0001\n}',
    );
    expect(() => nextVersions({} as never)).toThrow('numeric "descriptions"');
  });

  test('output is the held JSON shape: one-space indent, one-line class name arrays', () => {
    const text = decoder.decode(
      buildLegacy({ perks: { ...base, 100: perk(100, '<bold Hi />') } }, 'dim'),
    );
    expect(text).toBe(
      '{\n "100": {\n  "hash": 100,\n  "name": "Perk 100",\n  "descriptions": {\n   "en": [\n' +
        '    {\n     "linesContent": [\n      {\n       "text": "Hi",\n       "classNames": [ "bold" ]\n' +
        '      }\n     ]\n    }\n   ]\n  }\n }\n}',
    );
  });
});

describe('safe math (core evaluateMarkupMath)', () => {
  test.each([
    ['${1+2*3}', '7'],
    ['${10 - -2}', '12'],
    ['${7 -3}', '4'],
    ['${-1.005}', '-1'],
    ['${1/0}', 'Infinity'],
    ['${abc}', '${abc}'],
    ['${2; alert(1)}', '2'],
    ['a ${1+1} b ${1+1}', 'a 2 b 2'],
  ])('%s -> %s, the same as the held converter', (input, output) => {
    expect(doMath(input)).toBe(output);
  });

  // Documented divergences: JavaScript would fail on "5--3" and read "010" as octal 8. No data uses
  // either form (census of every math use: PROVENANCE.md).
  test.each([
    ['${5--3}', '8'],
    ['${010}', '10'],
  ])('%s -> %s (no JavaScript evaluation)', (input, output) => {
    expect(doMath(input)).toBe(output);
  });
});

describe('local replacements for lodash and tool-box', () => {
  test('pick keeps the order of the keys asked for and skips missing ones', () => {
    expect(Object.keys(pick({ b: 1, a: 2, c: undefined }, ['c', 'a', 'x', 'b']))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(pick(undefined, ['a'])).toEqual({});
  });

  test('cleanObject removes nullish, NaN, and empty values at every depth without touching its input', () => {
    const input = {
      a: [1, null, undefined, NaN, { b: {} }, [], 0, '', false],
      c: { d: { e: undefined } },
      f: NaN,
      g: 'kept',
    };
    const copy = structuredClone(input);
    expect(cleanObject(input)).toEqual({ a: [1, 0, '', false], g: 'kept' });
    expect(input).toEqual(copy);
    const top = [{}, 1, null, [[]]];
    expect(cleanObject(top)).toEqual([1]);
  });

  test('customJsonStringify puts the named arrays on one line', () => {
    expect(customJsonStringify({ classNames: ['a', 'b'], other: [1] }, ['classNames'])).toBe(
      '{\n "classNames": [ "a", "b" ],\n "other": [\n  1\n ]\n}',
    );
  });
});

test('packages/export never evaluates code and does not use lodash or tool-box (AC2)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'fixtures') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs|js|json)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  expect(files.length).toBeGreaterThan(20);
  const forbidden = [
    /new\s+Function\b/,
    /\beval\s*\(/,
    /from\s+['"]lodash/,
    /from\s+['"]@icemourne\//,
    /"(lodash|@icemourne\/[^"]+)"\s*:/,
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('engine.test.ts')) continue; // this file names the patterns
    for (const pattern of forbidden)
      expect(`${file}: ${pattern.test(text)}`).toBe(`${file}: false`);
  }
});
