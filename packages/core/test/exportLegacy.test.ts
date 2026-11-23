import { expect, test } from 'vitest';
import { exportLegacy, mergeLivePerks, translationMaxAge } from '../src/exportLegacy.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { database, exportCanonical, tooltip } from './helpers.js';

test('name groups reconcile accepted, recanonicalized, and ungrouped live records', () => {
  const catalog = {
    42: { name: 'Perk', type: 'Weapon Trait' },
    43: { name: 'Perk', type: 'Weapon Trait' },
  };
  const first = exportLegacy([tooltip()], 0, catalog);
  const other = exportLegacy([{ ...tooltip(), hash: 43 }], 0, catalog);
  const aliases = { 43: { to: 42, kind: 'name' as const } };
  const accepted = mergeLivePerks({ ...first, ...other }, {}, undefined, { aliases, catalog });
  expect(accepted[43]).toEqual({ hash: 43, aliasOf: 42, aliasKind: 'name', ...catalog[43] });
  const flipped = { 42: { to: 43, kind: 'name' as const } };
  const next = mergeLivePerks(accepted, other, undefined, { aliases: flipped, catalog });
  expect(next[42]).toMatchObject({ aliasOf: 43 });
  expect(next[43]).toEqual(other[43]);
  const undone = mergeLivePerks(next, {}, undefined, { aliases: {}, catalog });
  expect(undone).not.toHaveProperty('42');
  expect(undone[43]).toEqual(other[43]);
  expect(mergeLivePerks(undone, first, undefined, { aliases: {}, catalog })).toEqual({
    ...other,
    ...first,
  });
  expect(mergeLivePerks(next, {})).toEqual(next);
  expect(() => mergeLivePerks(other, {}, undefined, { aliases, catalog })).toThrow(
    'Publish canonical',
  );
  expect(() => exportLegacy([tooltip()], 0, { 42: catalog[42] }, aliases)).toThrow('name alias 43');
});

test('name reconciliation retargets existing incoming sandbox stubs on unrelated publishes', () => {
  const catalog = {
    42: { name: 'Perk', type: 'Weapon Trait' },
    43: { name: 'Perk', type: 'Weapon Trait' },
  };
  const live = {
    ...exportLegacy([tooltip(), { ...tooltip(), hash: 43 }], 0, catalog),
    700: { hash: 700, aliasOf: 43, aliasKind: 'sandbox' },
  };
  const generated = { 700: { to: 43, kind: 'sandbox' as const } };
  const grouped = mergeLivePerks(live, {}, undefined, {
    aliases: { ...generated, 43: { to: 42, kind: 'name' } },
    catalog,
  });
  expect(grouped[700]).toEqual({ hash: 700, aliasOf: 42, aliasKind: 'sandbox' });
  const ungrouped = mergeLivePerks(grouped, {}, undefined, { aliases: generated, catalog });
  expect(ungrouped).not.toHaveProperty('43');
  expect(ungrouped).not.toHaveProperty('700');
  const restored = mergeLivePerks(
    ungrouped,
    exportLegacy([{ ...tooltip(), hash: 43 }], 0, catalog, generated),
    undefined,
    { aliases: generated, catalog },
  );
  expect(restored[700]).toEqual({ hash: 700, aliasOf: 43, aliasKind: 'sandbox' });
  expect(mergeLivePerks(live, {})).toEqual(live);
});

test('a removed member keeps its live stubs until its own publish', () => {
  const facts = { name: 'Perk', type: 'Weapon Trait' };
  const catalog = { 42: facts, 43: facts, 50: facts };
  const generated = { 700: { to: 43, kind: 'sandbox' as const } };
  const grouped = { ...generated, 43: { to: 42, kind: 'name' as const } };
  const canonical = { ...tooltip(), hash: 42 };
  const live = {
    ...exportLegacy([canonical, { ...tooltip(), hash: 50 }], 0, catalog, grouped),
  };
  const removed = {
    43: { canonical: 42, by: { id: '1', login: 'a' }, at: '2026-11-23T00:00:00Z' },
  };
  const groups = { aliases: generated, catalog };
  // An unrelated publish, and the canonical's own, change nothing for the unpublished member.
  const other = exportLegacy([{ ...tooltip(), hash: 50 }], 0, catalog, generated);
  expect(mergeLivePerks(live, other, undefined, groups, removed)).toEqual(live);
  const main = exportLegacy([canonical], 0, catalog, generated);
  expect(main).not.toHaveProperty('43');
  expect(mergeLivePerks(live, main, undefined, groups, removed)).toEqual(live);
  // The Worker's rollback push names its keys through the picks argument instead.
  expect(
    mergeLivePerks(live, other, { keys: ['43', '700'], ...groups }, undefined, removed),
  ).toEqual(live);
  // A later recanonicalization of the remaining group still resolves to its live record.
  const flipped = { aliases: { ...generated, 42: { to: 50, kind: 'name' as const } }, catalog };
  const moved = mergeLivePerks(live, other, undefined, flipped, removed);
  expect([moved[43], moved[700]]).toMatchObject([{ aliasOf: 50 }, { aliasOf: 50 }]);
  // Its own publish ends the fallback for good.
  const own = exportLegacy([{ ...canonical, hash: 43 }], 0, catalog, generated);
  const published = mergeLivePerks(live, own, undefined, groups, removed);
  expect(published[43]).toEqual(own[43]);
  expect(published[43]).not.toHaveProperty('aliasOf');
  expect(published[700]).toEqual({ hash: 700, aliasOf: 43, aliasKind: 'sandbox' });
  expect(mergeLivePerks(published, other, undefined, groups, removed)).toEqual(published);
  // A tooltip associating the member publishes together with it (Review includes the pending
  // target); an association never points at a stub.
  const reader = { ...tooltip(), hash: 50, associated: [43] };
  const both = exportLegacy([reader, { ...canonical, hash: 43 }], 0, catalog, generated);
  const joint = mergeLivePerks(live, both, undefined, groups, removed);
  expect([joint[50], joint[43]]).toMatchObject([{ associated: [43] }, { hash: 43 }]);
  expect(joint[43]).not.toHaveProperty('aliasOf');
  // Bounds: no former live record, no manifest facts, or never live keeps the existing rule.
  const gone = { 43: live[43], 50: live[50] };
  expect(mergeLivePerks(gone, other, undefined, groups, removed)).not.toHaveProperty('43');
  const unnamed = { aliases: generated, catalog: { 42: facts, 50: facts } };
  expect(mergeLivePerks(live, other, undefined, unnamed, removed)).not.toHaveProperty('43');
  const never = { 42: live[42], 50: live[50] };
  expect(mergeLivePerks(never, other, undefined, groups, removed)).toEqual(never);
  // Ungroup (no removal record) still drops the stubs.
  expect(mergeLivePerks(live, other, undefined, groups)).not.toHaveProperty('43');
});

test.each(['kinetic', 'arc', 'solar', 'void', 'stasis', 'strand', 'prismatic'])(
  'passes %s markup unchanged into both consumer editor fields',
  (icon) => {
    const value = tooltip();
    value.text.en!.text = `<${icon}/>Transcendence`;
    expect(exportCanonical([value], 0)['42'].editor.en).toEqual({
      main: `<${icon}/>Transcendence`,
      secondary: `<${icon}/>Transcendence`,
    });
  },
);

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
  expect(exported['42'].editor.de).toEqual({
    main: expected,
    secondary: expected,
    ...(age > translationMaxAge ? { englishFallback: true } : {}),
  });
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
