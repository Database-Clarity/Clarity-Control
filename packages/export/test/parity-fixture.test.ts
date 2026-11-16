// G-PARITY on fixture (iii): every preset's bytes equal the held converter's (sha256 in legacy-sha256.json).
import { expect, test } from 'vitest';
import { buildLegacy, bungieIdentical, legacyPresets } from '../src/index.js';
import { lowerInput } from '../src/elementTags.js';
import { customJsonStringify } from '../src/converter/helpers.js';
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
// The pinned hashes are the held converter's on the fixture as stored (its tagged text dropped
// to the bare icon, the reason the engine lowers first). S5 adds exactly the fixture's name alias
// 2003 to seven legacy files; positively verify its expansion before removing that one row
// from the historical control. Never re-pin the old hashes or filter an entire kind away.
test.each(legacyPresets)(
  '%s: the non-Prismatic control changes only the explicit name alias',
  (preset) => {
    const control = JSON.parse(JSON.stringify(input).replaceAll('<prismatic', '<unverifiedElement'));
    const historical = JSON.parse(heldBytes(control, preset, identical));
    for (const hash of ['2003']) {
      if (preset === 'clarityV2') expect(historical[hash]).toEqual({ hash: 2003, aliasOf: 1003 });
      else {
        const expansion: Record<string, unknown> = {
          ...historical['1003'],
          hash: 2003,
          name: 'Name alias',
        };
        // This fixture stub has only a name, so its own facts replace the canonical's type.
        delete expansion.type;
        expect(historical[hash]).toEqual(expansion);
        delete historical[hash];
      }
    }
    expect(
      sha256(customJsonStringify(historical, ['stat', 'multiplier', 'weaponTypes', 'classNames'])),
    ).toBe(expected.fixture.files[preset]);
  },
);
