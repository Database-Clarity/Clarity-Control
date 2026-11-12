// Set bonuses in the legacy files (owner 2026-11-11): the decided cut-over exception of G-PARITY.
// A set bonus is a tooltip keyed by its sandbox perk hash (generator category `armor-set-bonus`).
// Expected diff against the held converter: set-bonus entries carry the legacy type name
// `Armor Set Bonus`, and a set bonus whose text equals its Bungie sandbox perk text is left out
// like every other Bungie-identical entry. Every other byte is the same.
import { expect, test } from 'vitest';
import {
  buildLegacy,
  bungieIdentical,
  deployedLegacyPresets,
  legacyPresets,
  type LegacyInput,
  type LegacyPreset,
} from '../src/index.js';
import { customJsonStringify } from '../src/converter/helpers.js';
import { databaseConverter } from '../src/converter/publisher.js';
import { editorDataInput, expected, fixtureInput, sha256 } from './helpers.js';

const decoder = new TextDecoder();
const parse = (bytes: Uint8Array) =>
  JSON.parse(decoder.decode(bytes)) as Record<string, Record<string, unknown>>;
const stringify = (value: unknown) =>
  customJsonStringify(value, ['stat', 'multiplier', 'weaponTypes', 'classNames']);

/** The held converter's own output: the copied converter without the set-bonus changes. */
const held = (input: LegacyInput, preset: LegacyPreset, identical: string[]) =>
  stringify(databaseConverter(preset, input.perks, new Set(identical)));

const { input, inventoryItem } = fixtureInput();
const identical = bungieIdentical(input, inventoryItem as never);

// Fixture set bonuses: 17188252 (own text), 17188254 (Bungie's text), 17188253 (sandbox alias of 17188252).
const withType: LegacyPreset[] = [
  'clarity',
  'crayon',
  'foundry',
  'braytech',
  'vaultZero',
  'clarityV2',
];
const keepsIdentical: LegacyPreset[] = ['crayon', 'vaultZero'];
/** The expected diff: the set-bonus entries whose `type` is renamed, per preset. */
const expectedDiff = Object.fromEntries(
  legacyPresets.map((preset) => [
    preset,
    !withType.includes(preset)
      ? []
      : keepsIdentical.includes(preset)
        ? ['17188252', '17188254']
        : ['17188252'],
  ]),
) as Record<LegacyPreset, string[]>;

test.each(legacyPresets)(
  '%s: the held output is unchanged; the only diff is the set-bonus type name',
  (preset) => {
    const before = held(input, preset, identical);
    expect(sha256(before)).toBe(expected.fixture.files[preset]);
    const after = decoder.decode(buildLegacy(input, preset, { identical }));
    expect(before.split('"armor-set-bonus"').length - 1).toBe(expectedDiff[preset].length);
    expect(after).toBe(before.replaceAll('"armor-set-bonus"', '"Armor Set Bonus"'));
    const output = parse(buildLegacy(input, preset, { identical }));
    for (const hash of expectedDiff[preset]) expect(output[hash].type).toBe('Armor Set Bonus');
  },
);

test.each(deployedLegacyPresets)(
  '%s: set bonuses are keyed by sandbox hash; sandbox aliases stay out',
  (preset) => {
    const output = parse(buildLegacy(input, preset, { identical }));
    expect(output['17188252']).toBeDefined();
    expect(output['17188252'].hash).toBe(17188252);
    expect(output['17188252']).not.toHaveProperty('itemHash');
    expect(output['17188253']).toBeUndefined();
    // Bungie-identical set bonuses follow the preset's rule, like any other entry.
    expect(output['17188254'] !== undefined).toBe(keepsIdentical.includes(preset));
  },
);

test('Bungie-identical set bonuses are found in the sandbox perk table', () => {
  // Real set bonuses have no inventory item: Bungie's text is in DestinySandboxPerkDefinition.
  const { 17188254: setBonus, ...items } = inventoryItem as Record<string, never>;
  expect(bungieIdentical(input, items)).toEqual(['3001', '3002']);
  expect(bungieIdentical(input, items, { 17188254: setBonus })).toEqual(identical);
  // The sandbox table only answers for set bonuses: 3001 is a weapon perk.
  const sandbox = { 17188254: setBonus, 3001: items[3001], 17188252: setBonus };
  expect(bungieIdentical(input, { 3002: items[3002] }, sandbox)).toEqual(['3002', '17188254']);
  // A set bonus whose text differs from Bungie's stays in.
  expect(
    bungieIdentical(input, {}, { 17188252: { displayProperties: { description: 'Other' } } }),
  ).toEqual([]);
  // Both tables found: the files are the same as with the old fixture manifest.
  const sandboxIdentical = bungieIdentical(input, items, { 17188254: setBonus });
  for (const preset of deployedLegacyPresets) {
    expect(buildLegacy(input, preset, { identical: sandboxIdentical })).toEqual(
      buildLegacy(input, preset, { identical }),
    );
  }
});

test('a set bonus with a legacy type name already is written as it is', () => {
  const named = structuredClone(input);
  (named.perks['17188252'] as { type: string }).type = 'Armor Set Bonus';
  expect(buildLegacy(named, 'clarity', { identical })).toEqual(
    buildLegacy(input, 'clarity', { identical }),
  );
  // The input object is never changed.
  expect((input.perks['17188252'] as { type: string }).type).toBe('armor-set-bonus');
});

test('real data: one set bonus adds exactly its entry to each of the 7 files', () => {
  // Editor-data 52007db has no set bonus yet; add one as core exportLegacy writes it, with the
  // generator's facts for sandbox perk 17188252 (Atheon's Memory 2 pc).
  const real = editorDataInput();
  const english = 'Fixture set-bonus text, not Bungie text.';
  const added: LegacyInput = {
    ...real.input,
    perks: {
      ...real.input.perks,
      17188252: {
        hash: 17188252,
        name: "Atheon's Memory (2 pc): Radiolaria Breach",
        type: 'armor-set-bonus',
        editor: { en: { main: english, secondary: english } },
        uploadedBy: 'fixture',
        lastUpload: 1700000000000,
        inLiveDatabase: false,
        uploadToLive: false,
        updateTracker: {
          descriptions: { en: { lastUpdate: 1700000000000, updatedBy: 'fixture' } },
        },
      } as never,
    },
  };
  for (const preset of deployedLegacyPresets) {
    const before = buildLegacy(real.input, preset, { identical: real.identical });
    expect(sha256(before)).toBe(expected.editorData.files[preset]);
    const after = parse(buildLegacy(added, preset, { identical: real.identical }));
    const { 17188252: entry, ...rest } = after;
    expect(entry.hash).toBe(17188252);
    expect(entry.name).toBe("Atheon's Memory (2 pc): Radiolaria Breach");
    if (withType.includes(preset)) expect(entry.type).toBe('Armor Set Bonus');
    else expect(entry).not.toHaveProperty('type');
    // Every other entry, in order, is byte for byte the file without the set bonus.
    expect(stringify(rest)).toBe(decoder.decode(before));
  }
}, 300_000);
