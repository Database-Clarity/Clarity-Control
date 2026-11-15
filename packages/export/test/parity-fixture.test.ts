// G-PARITY on fixture (iii): every preset's bytes equal the held converter's (sha256 in legacy-sha256.json).
import { expect, test } from 'vitest';
import { buildLegacy, bungieIdentical, legacyPresets } from '../src/index.js';
import { lowerInput } from '../src/elementTags.js';
import {
  expected,
  fixtureInput,
  fixtureInputPath,
  heldBytes,
  sha256,
  textSha256,
} from './helpers.js';

const { input, inventoryItem } = fixtureInput();
const identical = bungieIdentical(input, inventoryItem as never);

test('the fixture is the one the hashes were taken from', () => {
  expect(textSha256(fixtureInputPath)).toBe(expected.fixture.inputSha256);
  expect(identical).toEqual(['3001', '3002', '17188254']);
});

// The fixture's set bonuses carry the legacy type name, the decided cut-over exception (see
// set-bonus.test.ts); with that one rename undone, every byte is the held converter's for the
// fixture with its element-tagged text lowered (ELEMENT-TAGS-2: the engine lowers tagged text, so
// the files are what the lowered form, written by hand, builds).
test.each(legacyPresets)('%s matches the held converter byte for byte', (preset) => {
  const text = new TextDecoder().decode(buildLegacy(input, preset, { identical }));
  expect(text.replaceAll('"Armor Set Bonus"', '"armor-set-bonus"')).toBe(
    heldBytes(lowerInput(input), preset, identical),
  );
});

// The old converter dropped Prismatic tokens, including their tagged text. An unknown token
// reproduces that control while preserving span boundaries; S1 classifies the new symbol delta.
test.each(legacyPresets)('%s: the non-Prismatic control retains the pinned bytes', (preset) => {
  const control = JSON.parse(JSON.stringify(input).replaceAll('<prismatic', '<unverifiedElement'));
  expect(sha256(heldBytes(control, preset, identical))).toBe(expected.fixture.files[preset]);
});
