// G-PARITY on input (i), the published input today: every preset's bytes equal the held converter's.
import { expect, test } from 'vitest';
import { buildLegacy, legacyPresets } from '../src/index.js';
import { expected, liveInput, sha256 } from './helpers.js';

const { bytes, input, identical } = liveInput();

test('input (i) is the pinned converter-v2-test file', () => {
  expect(sha256(bytes)).toBe(expected.live.inputSha256);
});

test.each(legacyPresets)(
  '%s matches the held converter byte for byte',
  (preset) => {
    expect(sha256(buildLegacy(input, preset, { identical }))).toBe(expected.live.files[preset]);
  },
  60_000,
);
