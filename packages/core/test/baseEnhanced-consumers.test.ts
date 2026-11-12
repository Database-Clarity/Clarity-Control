import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { exportLegacy, baseEnhancedPublishMessage, migrateLegacy } from '../src/index.js';
import { database, tooltip } from './helpers.js';

it.each(['live', 'intermediate'])('keeps retained %s consumer bytes identical to the original golden', (name) => {
  const source = database(name);
  const values = migrateLegacy(source);
  expect(values).toHaveLength(2761);
  const retained = exportLegacy(values, 0);
  const omitted = Object.values(source.perks).filter(
    (perk) => perk.hash > 3 && !Object.values(perk.editor).some((text) => text?.main.trim()),
  );
  expect(Object.keys(retained)).toHaveLength(name === 'live' ? 1777 : 1779);
  expect(Object.keys(source.perks).filter((hash) => !retained[hash])).toEqual(
    omitted.map((perk) => String(perk.hash)),
  );
  // Reinsert only permitted empty entries from their immutable source metadata.
  // Keeping the ORIGINAL full-output digest proves every retained serialized byte
  // still matches, rather than approving a newly generated candidate digest.
  const restored = { ...retained };
  for (const perk of omitted) {
    const value = values.find((tooltip) => tooltip.hash === perk.hash)!;
    const editor = structuredClone(perk.editor);
    for (const text of Object.values(editor)) if (text) text.secondary = text.main;
    restored[perk.hash] = {
      ...value.legacy,
      hash: perk.hash,
      editor,
      uploadedBy: perk.uploadedBy,
      lastUpload: perk.lastUpload,
      inLiveDatabase: perk.inLiveDatabase,
      uploadToLive: perk.uploadToLive,
      updateTracker: {
        ...value.legacy?.updateTracker,
        descriptions: perk.updateTracker?.descriptions ?? {},
      },
    };
  }
  const actual = JSON.stringify(restored);
  const expected =
    name === 'live'
      ? '22fd496f9d9970eb2750697f51374f0849395aa9000df1ee1a909e6de819f5a7'
      : '65cb3aca83d4ecd45631ff162fa0923b656cf77fe53b2ed47202ea667a159bb7';
  expect(createHash('sha256').update(actual).digest('hex')).toBe(expected);
});
it('CI guard: converter input rejects complete and incomplete native pairs', () => {
  for (const text of ['{{a}{b}}', '{{a}{', 'import main from 123\n{{a}{b}}']) {
    const value = tooltip();
    value.text.en!.text = text;
    expect(() => exportLegacy([value], 0)).toThrow(baseEnhancedPublishMessage);
  }
});
