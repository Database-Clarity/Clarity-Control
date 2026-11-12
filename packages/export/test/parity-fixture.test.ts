// G-PARITY on fixture (iii): every preset's bytes equal the held converter's (sha256 in legacy-sha256.json).
import { expect, test } from 'vitest';
import { buildLegacy, bungieIdentical, legacyPresets } from '../src/index.js';
import { expected, fixtureInput, fixtureInputPath, sha256, textSha256 } from './helpers.js';

const { input, inventoryItem } = fixtureInput();
const identical = bungieIdentical(input, inventoryItem as never);

test('the fixture is the one the hashes were taken from', () => {
  expect(textSha256(fixtureInputPath)).toBe(expected.fixture.inputSha256);
  expect(identical).toEqual(['3001', '3002', '17188254']);
});

// The fixture's set bonuses carry the legacy type name, the decided cut-over exception (see
// set-bonus.test.ts); with that one rename undone, every byte is the held converter's.
test.each(legacyPresets)('%s matches the held converter byte for byte', (preset) => {
  const text = new TextDecoder().decode(buildLegacy(input, preset, { identical }));
  expect(sha256(text.replaceAll('"Armor Set Bonus"', '"armor-set-bonus"'))).toBe(
    expected.fixture.files[preset],
  );
});
