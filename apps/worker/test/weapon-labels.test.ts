import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeWeaponTypeLabels, markupWeaponTypes } from '@clarity/core';
import { Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const push = () => fixture.request('/push-live', 'POST', { hashes: [123] });
const settings = () =>
  (fixture.live as { databaseSettings: Record<string, unknown> }).databaseSettings;
const liveBytes = () => JSON.stringify(fixture.live);

describe('push-live weapon-type labels', () => {
  it('writes English defaults for every canonical name when the generator has no table', async () => {
    expect((await push()).status).toBe(200);
    const labels = settings().weaponTypeLabels as Record<string, Record<string, string>>;
    expect(Object.keys(labels)).toEqual([...markupWeaponTypes]);
    expect(labels['Hand Cannon']).toEqual({ en: 'Hand Cannon' });
  });

  it('writes the generator table with every language, English defaults for missing names', async () => {
    fixture.weaponTypeTable = {
      'Hand Cannon': { en: 'Hand Cannon', de: 'Handfeuerwaffe', ja: 'ハンドキャノン' },
      Sword: { en: 'Sword', de: 'Schwert' },
    };
    expect((await push()).status).toBe(200);
    const labels = settings().weaponTypeLabels as Record<string, Record<string, string>>;
    expect(labels['Hand Cannon']).toEqual({
      en: 'Hand Cannon',
      de: 'Handfeuerwaffe',
      ja: 'ハンドキャノン',
    });
    expect(labels.Sword).toEqual({ en: 'Sword', de: 'Schwert' });
    expect(labels.Glaive).toEqual({ en: 'Glaive' });
    expect(Object.keys(labels)).toEqual([...markupWeaponTypes]);
  });

  it('keeps every other databaseSettings key and every tooltip entry as live has them', async () => {
    fixture.live = {
      ...fixture.live,
      databaseSettings: {
        folders: { saved: [{ name: 'A', has: [1] }] },
        enhancedPerks: { '5': { name: 'x', linkedWith: 6 } },
        somethingNew: { keep: ['me'] },
      },
    };
    expect((await push()).status).toBe(200);
    expect(settings()).toEqual({
      folders: { saved: [{ name: 'A', has: [1] }] },
      enhancedPerks: { '5': { name: 'x', linkedWith: 6 } },
      somethingNew: { keep: ['me'] },
      weaponTypeLabels: completeWeaponTypeLabels(),
    });
    const perks = (fixture.live as { perks: Record<string, unknown> }).perks;
    expect(perks['999']).toEqual({ hash: 999, editor: { en: { main: 'untouched' } } });
  });

  it('replaces a stale live table, in place', async () => {
    fixture.live = {
      ...fixture.live,
      databaseSettings: {
        weaponTypeLabels: { Sword: { en: 'Swords' }, Retired: { en: 'Old' } },
        folders: { saved: [] },
      },
    };
    expect((await push()).status).toBe(200);
    expect(Object.keys(settings())).toEqual(['weaponTypeLabels', 'folders']);
    expect(settings().weaponTypeLabels).toEqual(completeWeaponTypeLabels());
  });

  it('is idempotent: the same table gives identical bytes, whatever its key order', async () => {
    fixture.weaponTypeTable = {
      Sword: { de: 'Schwert', en: 'Sword' },
      'Hand Cannon': { en: 'Hand Cannon', de: 'Handfeuerwaffe' },
    };
    expect((await push()).status).toBe(200);
    const first = liveBytes();
    expect((await push()).status).toBe(200);
    expect(liveBytes()).toBe(first);
    fixture.weaponTypeTable = {
      'Hand Cannon': { de: 'Handfeuerwaffe', en: 'Hand Cannon' },
      Sword: { en: 'Sword', de: 'Schwert' },
    };
    expect((await push()).status).toBe(200);
    expect(liveBytes()).toBe(first);
  });

  it('a changed table changes only the label table', async () => {
    expect((await push()).status).toBe(200);
    const before = JSON.parse(liveBytes()) as { databaseSettings: Record<string, unknown> };
    fixture.weaponTypeTable = { Sword: { en: 'Sword', de: 'Schwert' } };
    expect((await push()).status).toBe(200);
    const after = JSON.parse(liveBytes()) as typeof before;
    expect(after).toEqual({
      ...before,
      databaseSettings: {
        ...before.databaseSettings,
        weaponTypeLabels: completeWeaponTypeLabels({ Sword: { en: 'Sword', de: 'Schwert' } }),
      },
    });
  });

  it('treats other upstream failures like the other catalog files', async () => {
    fixture.weaponTypeStatus = 500;
    expect((await push()).status).toBe(502);
    expect(fixture.writes).toHaveLength(0);
  });

  it('rejects a table without English', async () => {
    fixture.weaponTypeTable = { Sword: { de: 'Schwert' } };
    expect((await push()).status).not.toBe(200);
    expect(fixture.writes).toHaveLength(0);
  });
});
