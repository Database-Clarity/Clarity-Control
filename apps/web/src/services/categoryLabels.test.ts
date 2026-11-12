import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  categoryGroups,
  categorySpecs,
  nonEmptyCategories,
  presentCategories,
  previousCategoryLabel,
  unknownCategoryLabel,
} from './categoryLabels';

// Every category id in Description-data-generator templates/v2/categories.json (2026-11-12).
const generatorIds = [
  'armor-trait-exotic',
  'armor-trait-exotic-class-item',
  'armor-mod-general',
  'armor-set-bonus',
  'armor-mod-combat',
  'armor-mod-activity',
  'armor-mod-seasonal',
  'weapon-perk',
  'weapon-perk-exotic',
  'weapon-trait',
  'weapon-trait-exotic',
  'weapon-trait-origin',
  'weapon-trait-origin-exotic',
  'weapon-trait-enhanced',
  'weapon-trait-enhanced-exotic',
  'weapon-frame',
  'weapon-frame-exotic',
  'weapon-frame-enhanced',
  'weapon-frame-enhanced-exotic',
  'weapon-catalyst-exotic',
  'weapon-mod',
  'weapon-perk-enhanced',
  'weapon-perk-enhanced-exotic',
  'weapon-trait-origin-enhanced',
  'weapon-trait-origin-enhanced-exotic',
  'weapon-mod-enhanced',
  'weapon-mod-enhanced-exotic',
  'subclass-fragment',
  'subclass-aspect',
  'subclass-super',
  'subclass-grenade',
  'subclass-melee',
  'subclass-class',
  'subclass-movement',
  'verbs',
  'ghost-mod',
];
const derivedIds = ['weapon-attachment', 'attachment-effect', 'inactive-placeholder'];

describe('category registry', () => {
  it('labels, groups, and orders every generator and derived category', () => {
    for (const id of [...generatorIds, ...derivedIds]) {
      expect(categorySpecs[id], id).toBeDefined();
      expect(categoryGroups).toContain(categorySpecs[id].group);
    }
    const orders = Object.values(categorySpecs).map((entry) => entry.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('follows the approved rules: plural labels, Ghost on its own, groups in order', () => {
    expect(categorySpecs['ghost-mod'].group).toBe('Ghost');
    expect(categorySpecs['weapon-trait-origin-enhanced'].label).toBe('Enhanced Origin Traits');
    expect(categorySpecs['armor-mod-seasonal'].label).toBe('Artifact Perks');
    expect(categorySpecs['armor-trait-exotic'].label).toBe('Exotic Armor');
    expect(categorySpecs['armor-trait-exotic-class-item']).toMatchObject({
      label: 'Exotic Class Items',
      group: 'Armor',
    });
    // Directly after Exotic Armor in the Armor area.
    const armour = Object.entries(categorySpecs)
      .filter(([, entry]) => entry.group === 'Armor')
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id]) => id);
    expect(armour.slice(0, 2)).toEqual(['armor-trait-exotic', 'armor-trait-exotic-class-item']);
    const rank = (id: string) => categoryGroups.indexOf(categorySpecs[id].group);
    const byOrder = Object.keys(categorySpecs).sort(
      (a, b) => categorySpecs[a].order - categorySpecs[b].order,
    );
    const ranks = byOrder.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(
      Math.max(...Object.values(categorySpecs).map((entry) => entry.label.length)),
    ).toBeLessThan(32);
  });

  it('presents generator categories without touching ids or legacy types', () => {
    const [presented] = presentCategories([
      {
        id: 'weapon-trait',
        label: 'Weapon Trait',
        group: 'Weapons',
        order: 120,
        legacyType: 'Weapon Trait',
      },
    ]);
    expect(presented).toEqual({
      id: 'weapon-trait',
      label: 'Weapon Perks',
      group: 'Weapons',
      order: 100,
      legacyType: 'Weapon Trait',
    });
  });

  it('lists presented categories in the editor order, not the generator order', () => {
    const presented = presentCategories([
      { id: 'ghost-mod', label: 'Ghost Mod', group: 'Ghost', order: 400 },
      { id: 'subclass-super', label: 'Subclass Super', group: 'Subclasses', order: 320 },
      { id: 'armor-mod-general', label: 'Armor Mod General', group: 'Armor', order: 20 },
      { id: 'weapon-perk', label: 'Weapon Perk', group: 'Weapons', order: 100 },
    ]);
    expect(presented.map((entry) => entry.label)).toEqual([
      'Weapon Parts',
      'Armor Mods',
      'Ghost Mods',
      'Supers',
    ]);
  });

  it('keeps an unknown id as a visible warning', () => {
    const [presented] = presentCategories([
      { id: 'brand-new', label: 'Brand New', group: 'X', order: 1 },
    ]);
    expect(presented).toMatchObject({ label: unknownCategoryLabel('brand-new'), group: 'Other' });
    expect(presented.label).toBe('Other: brand-new');
  });

  it('keeps old names as search aliases', () => {
    expect(previousCategoryLabel('weapon-trait')).toBe('Weapon Trait');
    expect(previousCategoryLabel('armor-set-bonus')).toBe('');
    expect(previousCategoryLabel('nope')).toBe('');
  });

  it('hides categories without items from pickers', () => {
    const items = { 1: { categoryId: 'a' } };
    const categories = [{ id: 'a' }, { id: 'b' }];
    expect(nonEmptyCategories({ categories, items })).toEqual([{ id: 'a' }]);
  });

  it('leaves no old category label in UI code', () => {
    const old = Object.values(categorySpecs)
      .map((entry) => entry.was)
      .filter((label): label is string => !!label);
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|scss)$/.test(name) && !/\.test\./.test(name)) files.push(path);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('categoryLabels.ts')) continue;
      const text = readFileSync(file, 'utf8')
        .split(String.fromCharCode(10))
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join(String.fromCharCode(10));
      for (const label of old) {
        if (new RegExp(`(['"\`])${label.replace(/[&]/g, '\\$&')}\\1`).test(text)) {
          offenders.push(`${file}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
