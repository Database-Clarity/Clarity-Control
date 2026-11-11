// G-PARITY on input (ii), editor-data through core exportLegacy (with alias stubs): every preset's
// bytes equal the held converter's.
import { expect, test } from 'vitest';
import { buildLegacy, legacyPresets } from '../src/index.js';
import { editorDataInput, expected, sha256 } from './helpers.js';

const { bytes, input, identical } = editorDataInput();

test('input (ii) is the pinned editor-data export', () => {
  expect(sha256(bytes)).toBe(expected.editorData.inputSha256);
});

test.each(legacyPresets)(
  '%s matches the held converter byte for byte',
  (preset) => {
    expect(sha256(buildLegacy(input, preset, { identical }))).toBe(
      expected.editorData.files[preset],
    );
  },
  60_000,
);
