import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { exportLegacy, baseEnhancedPublishMessage, migrateLegacy } from '../src/index.js';
import { database, tooltip } from './helpers.js';

it.each(['live', 'intermediate'])('keeps %s legacy fixture consumer bytes identical', (name) => {
  const values = migrateLegacy(database(name));
  expect(values).toHaveLength(2761);
  const actual = JSON.stringify(exportLegacy(values, 0));
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
