import { expect, test } from 'vitest';
import { exportLegacy, translationMaxAge } from '../src/exportLegacy.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { database, exportCanonical, tooltip } from './helpers.js';

test('exports main into both editor fields, including explicitly empty text', () => {
  const value = tooltip();
  value.text.de = { ...value.text.en!, text: '' };
  const result = exportCanonical([value], 123);
  expect(result['42'].editor).toEqual({
    en: { main: 'English', secondary: 'English' },
    de: { main: '', secondary: '' },
  });
  expect(result['42'].lastUpload).toBe(123);
});
test.each([
  [translationMaxAge - 1, 'Deutsch'],
  [translationMaxAge, 'Deutsch'],
  [translationMaxAge + 1, 'English'],
])('fallback compares English-source age precisely at %i ms', (age, expected) => {
  const value = tooltip();
  const englishTime = Date.parse(value.text.en!.updatedAt);
  value.text.de = {
    text: 'Deutsch',
    updatedBy: 'bob',
    updatedAt: value.text.en!.updatedAt,
    sourceUpdatedAt: new Date(englishTime - age).toISOString(),
  };
  const exported = exportCanonical([value], englishTime);
  expect(exported['42'].editor.de).toEqual({ main: expected, secondary: expected });
  if (expected === 'English') {
    expect(exported['42'].updateTracker?.descriptions.de?.updatedBy).toBe('alice');
  }
});
test('unknown source age or missing English never discards translation', () => {
  const value = tooltip();
  value.text.de = { ...value.text.en!, text: 'Deutsch' };
  expect(exportCanonical([value], 0)['42'].editor.de?.main).toBe('Deutsch');
  delete value.text.en;
  value.text.de.sourceUpdatedAt = '1970-01-01T00:00:00Z';
  expect(exportCanonical([value], 0)['42'].editor.de?.main).toBe('Deutsch');
});
test('catalog restores manifest facts without storing them in Tooltip', () => {
  expect(
    exportLegacy([tooltip()], 0, {
      '42': { name: 'Perk', type: 'Weapon Perk', itemHash: 12, itemName: 'Weapon' },
    })['42'],
  ).toMatchObject({ name: 'Perk', type: 'Weapon Perk', itemHash: 12, itemName: 'Weapon' });
  expect(() => exportLegacy([tooltip()], 0, {})).toThrow('Missing manifest facts');
});
test('retired weapon facts are stripped from canonical entries and alias stubs', () => {
  const catalog = {
    '42': { name: 'Frame', type: 'Weapon Frame', weaponTypes: ['Bow', 'Sniper'] },
    '43': { name: 'Frame', type: 'Weapon Frame', weaponTypes: ['Bow'] },
    '44': { name: 'Sandbox', type: 'Weapon Perk' },
  };
  const aliases = {
    43: { to: 42, kind: 'frame' as const },
    44: { to: 42, kind: 'sandbox' as const },
  };
  const result = exportLegacy([tooltip()], 0, catalog, aliases);
  expect(result['42']).not.toHaveProperty('weaponTypes');
  expect(result['43']).toMatchObject({ aliasOf: 42 });
  expect(result['43']).not.toHaveProperty('weaponTypes');
  expect(result['44']).not.toHaveProperty('weaponTypes');
  expect(exportLegacy([tooltip()], 0, { '42': { name: 'P', type: 'T' } })['42']).not.toHaveProperty(
    'weaponTypes',
  );
});
test('rejects duplicate hashes and invalid export times', () => {
  expect(() => exportLegacy([tooltip(), tooltip()], 0)).toThrow('Duplicate');
  for (const now of [-1, NaN, Infinity, 1.5]) expect(() => exportLegacy([], now)).toThrow();
});
test('preserves historical tracker authorship even when that language has no editor text', () => {
  const value = tooltip();
  value.legacy = {
    updateTracker: { descriptions: { ko: { lastUpdate: 1000, updatedBy: 'translator' } } },
  };
  expect(exportCanonical([value], 0)['42'].updateTracker?.descriptions.ko).toEqual({
    lastUpdate: 1000,
    updatedBy: 'translator',
  });
  expect(exportCanonical([value], 0)['42'].editor.ko).toBeUndefined();
});
test('all legacy stat fields and tracker credits are omitted from export', () => {
  const source = database('live');
  const perk = source.perks['0'];
  perk.stats = { Damage: [{ active: { stat: [10] } }] };
  perk.importStatsFrom = 123;
  perk.duration = [2, 5];
  perk.activationCondition = 'On hit';
  perk.updateTracker = {
    descriptions: { en: { lastUpdate: 1000, updatedBy: 'author' } },
    stats: { lastUpdate: 2000, updatedBy: 'stat-author' },
  };
  const result = exportCanonical(migrateLegacy(source), 0);
  for (const entry of Object.values(result)) {
    for (const field of ['stats', 'importStatsFrom', 'duration', 'activationCondition']) {
      expect(entry).not.toHaveProperty(field);
    }
    expect(entry.updateTracker).not.toHaveProperty('stats');
  }
  expect(result['0'].updateTracker?.descriptions.en?.updatedBy).toBe('author');
});
test('associated keeps authored order, deduplicated to first occurrence, and is omitted when empty', () => {
  const value = tooltip();
  expect(exportCanonical([value], 0)['42']).not.toHaveProperty('associated');
  expect(JSON.stringify(exportCanonical([value], 0)['42'])).not.toContain('associated');
  value.associated = [900, 7, 100, 43, 44, 42];
  const aliases = {
    43: { to: 7, kind: 'frame' as const },
    44: { to: 42, kind: 'sandbox' as const },
  };
  expect(exportLegacy([value], 0, undefined, aliases)['42']).toHaveProperty(
    'associated',
    [900, 7, 100],
  );
  expect(exportCanonical([value], 0)['42'].associated).toEqual([900, 7, 100, 43, 44]);
  value.associated = [44];
  expect(exportLegacy([value], 0, undefined, aliases)['42']).not.toHaveProperty('associated');
});
