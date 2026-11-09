import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { armorStatCategory, classifyItem } from '../compendium/itemClassification';
import { activityDisplay } from '../../services/activityLabels';
import { artifactOrder, artifactSeasons } from '../../services/artifactLabels';
import { categoryDisplay } from '../../services/categoryLabels';
import {
  classifiedCategory,
  exoticWeaponsCategory,
  finderCategoryId,
  groupedSection,
  navigationGroups,
} from './catalog';

const item = (hash: number, name: string, categoryId: string, extra = {}) => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...extra,
});
const weapon = (hash: number, name: string) => ({
  itemHash: hash,
  itemName: name,
  owners: [hash],
  ownerNames: { [hash]: name },
});
const categories = [
  { id: 'weapon-trait-exotic', label: 'Exotic Weapon Perks', group: 'Weapons', order: 102 },
  { id: 'weapon-frame-exotic', label: 'Exotic Frames', group: 'Weapons', order: 122 },
  { id: 'weapon-catalyst-exotic', label: 'Exotic Catalysts', group: 'Weapons', order: 130 },
  { id: 'weapon-perk-exotic', label: 'Exotic Weapon Parts', group: 'Weapons', order: 152 },
  { id: 'armor-mod-general', label: 'Armor Mods', group: 'Armor', order: 220 },
  { id: 'armor-mod-activity', label: 'Activity Mods', group: 'Armor', order: 240 },
];
const dead = weapon(1001, 'Dead Messenger');
const hard = weapon(1002, 'Hard Light');
const whisper = weapon(1003, 'Whisper of the Worm');
const items = {
  // Dead Messenger: a frame, a shared perk, a catalyst, a part (kind order, whatever the hash order).
  107: item(107, 'Dead Part', 'weapon-perk-exotic', dead),
  102: item(102, 'Dead Catalyst', 'weapon-catalyst-exotic', dead),
  101: item(101, 'The Fundamentals', 'weapon-trait-exotic', {
    itemHash: 1001,
    itemName: 'Dead Messenger',
    owners: [1001, 1002],
    ownerNames: { 1001: 'Dead Messenger', 1002: 'Hard Light' },
  }),
  100: item(100, 'Dead Frame', 'weapon-frame-exotic', dead),
  103: item(103, 'Light Frame', 'weapon-frame-exotic', hard),
  105: item(105, 'Worm Perk B', 'weapon-trait-exotic', whisper),
  104: item(104, 'Worm Perk A', 'weapon-trait-exotic', whisper),
  // A second definition of Whisper (same name): one weapon, not two groups.
  106: item(106, 'Worm Catalyst', 'weapon-catalyst-exotic', {
    itemHash: 1004,
    itemName: 'Whisper of the Worm',
    owners: [1004],
    ownerNames: { 1004: 'Whisper of the Worm' },
  }),
  // Real manifest hashes: the plug categories enhancements.raid_v520 and enhancements.season_maverick.
  518521232: item(518521232, 'Precise Oracle Disruptor', 'armor-mod-activity'),
  1560574695: item(1560574695, 'Nightmare Breaker', 'armor-mod-activity'),
  900: item(900, 'No Manifest Mod', 'armor-mod-activity'),
};
const data = {
  categories,
  items,
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-09T00:00:00Z',
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

const section = (id: string, source = data, query = '') =>
  navigationGroups(source, query)
    .flatMap((group) => group.sections)
    .find((candidate) => candidate.id === id);
const names = (hashes: { hash: number }[]) => hashes.map((entry) => entry.hash);

describe('Exotic Weapons category', () => {
  it('replaces the four kind categories in the first dropdown with one', () => {
    const ids = navigationGroups(data, '').flatMap((group) => group.sections.map((s) => s.id));
    expect(ids).toEqual([exoticWeaponsCategory, 'armor-mod-activity']);
    expect(section(exoticWeaponsCategory)?.label).toBe('Exotic Weapons');
    for (const kind of categories.slice(0, 4)) {
      expect(finderCategoryId(kind.id)).toBe(exoticWeaponsCategory);
    }
    expect(finderCategoryId('armor-mod-general')).toBe('armor-mod-general');
  });

  it('keeps the generator category on each item (the editor kicker and export are unchanged)', () => {
    expect(classifiedCategory(items[101], data)?.id).toBe('weapon-trait-exotic');
    expect(classifiedCategory(items[100], data)?.label).toBe('Exotic Frames');
  });

  it('groups by owner, weapons A–Z, entries Frame, Perk, Catalyst, Part', () => {
    const grouped = groupedSection(section(exoticWeaponsCategory)!, data)!;
    expect(grouped.groups.map((group) => [group.label, names(group.entries)])).toEqual([
      ['Dead Messenger', [100, 101, 102, 107]],
      ['Hard Light', [103, 101]],
      ['Whisper of the Worm', [104, 105, 106]],
    ]);
    expect(names(grouped.all)).toEqual([100, 101, 102, 107, 103, 101, 104, 105, 106]);
  });

  it('lists a shared perk under each owner and names the other one', () => {
    const grouped = groupedSection(section(exoticWeaponsCategory)!, data)!;
    expect(grouped.owners.get(101)?.map((group) => group.label)).toEqual([
      'Dead Messenger',
      'Hard Light',
    ]);
    expect(grouped.owners.has(100)).toBe(false);
    expect(grouped.firstGroup.get(101)).toBe('1001');
  });

  it('treats two definitions of one weapon name as one group, identified by its lowest hash', () => {
    const grouped = groupedSection(section(exoticWeaponsCategory)!, data)!;
    expect(grouped.byId.get('1003')?.label).toBe('Whisper of the Worm');
    expect(grouped.byId.has('1004')).toBe(false);
    expect(grouped.firstGroup.get(106)).toBe('1003');
  });

  it('keeps group ids when a search narrows the section', () => {
    const found = groupedSection(section(exoticWeaponsCategory, data, 'worm catalyst')!, data)!;
    expect(found.groups.map((group) => [group.id, names(group.entries)])).toEqual([
      ['1003', [106]],
    ]);
  });

  it('indexes every entry by hash and group, so a hash listed twice is two positions', () => {
    const grouped = groupedSection(section(exoticWeaponsCategory)!, data)!;
    expect(grouped.allIndex.get('101:1001')).toBe(1);
    expect(grouped.allIndex.get('101:1002')).toBe(5);
    expect(grouped.byId.get('1002')?.index.get('101:1002')).toBe(1);
  });
});

describe('Activity Mods', () => {
  it('groups by the manifest plug category in registry order, never by name', () => {
    const grouped = groupedSection(section('armor-mod-activity')!, data)!;
    expect(grouped.groups.map((group) => [group.label, names(group.entries)])).toEqual([
      ['Vault of Glass', [518521232]],
      ['Nightmares (Shadowkeep)', [1560574695]],
      ['Unknown activity', [900]],
    ]);
    expect(grouped.allLabel).toBe('All activities');
    expect(grouped.groupLabel).toBe('Activity');
  });

  it('names the ten activities and falls back visibly for an unknown plug', () => {
    const labels = [
      'season_outlaw',
      'raid_garden',
      'raid_descent',
      'raid_v520',
      'raid_v600',
      'raid_v620',
      'raid_v700',
      'raid_v720',
      'raid_v800',
      'season_maverick',
    ].map((plug) => activityDisplay(`enhancements.${plug}`).label);
    expect(labels).toEqual([
      'Last Wish',
      'Garden of Salvation',
      'Deep Stone Crypt',
      'Vault of Glass',
      'Vow of the Disciple',
      "King's Fall",
      'Root of Nightmares',
      "Crota's End",
      "Salvation's Edge",
      'Nightmares (Shadowkeep)',
    ]);
    const orders = ['raid_v700', 'raid_v720', 'raid_v800', 'season_maverick'].map(
      (plug) => activityDisplay(`enhancements.${plug}`).order,
    );
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(activityDisplay('enhancements.raid_v900').label).toBe('Other: enhancements.raid_v900');
    expect(
      activityDisplay('enhancements.raid_v900', 'Active only in the "Hall of Echoes" raid.').label,
    ).toBe('Hall of Echoes');
    expect(activityDisplay(undefined).label).toBe('Unknown activity');
    expect(activityDisplay('enhancements.raid_v900').order).toBeGreaterThan(
      activityDisplay('enhancements.season_maverick').order,
    );
  });
});

describe('Stat-only Armor Mods', () => {
  const stat = (hash: number, name: string, description: string) =>
    item(hash, name, 'armor-mod-general', { inGameDescription: description });
  const statData = {
    ...data,
    categories,
    items: {
      309000506: stat(
        309000506,
        '+Grenade / -Melee',
        "Increases this armor's Tuned stat at the cost of a small amount of the Melee stat.",
      ),
      350061697: stat(350061697, 'Minor Super Mod', ''),
      12: item(12, 'Ordinary Mod', 'armor-mod-general'),
    },
  } as unknown as EditorData;

  it('classifies a manifest stat/tuning plug as Stat-only Armor Mods, scope unchanged', () => {
    for (const hash of [309000506, 350061697]) {
      const result = classifyItem(statData.items[hash]);
      expect(result?.categoryId).toBe(armorStatCategory);
      expect(result?.ruleId).toBe('manifest-armor-stat');
      expect(result?.excluded).toBe(true);
    }
    expect(classifyItem(statData.items[12])).toBeUndefined();
  });

  it('lists them apart from Armor Mods in the finder', () => {
    const lists = (id: string) => names(section(id, statData)?.items ?? []);
    expect(lists('armor-mod-stat').sort()).toEqual([309000506, 350061697]);
    expect(lists('armor-mod-general')).toEqual([12]);
    expect(section('armor-mod-stat', statData)?.label).toBe('Stat-only Armor Mods');
    expect(classifiedCategory(statData.items[309000506], statData)?.label).toBe(
      'Stat-only Armor Mods',
    );
  });

  it('lets an editor move one back to Armor Mods without changing its matching scope', () => {
    const moved: Tooltip = {
      hash: 309000506,
      text: {},
      associated: [],
      custom: { name: '+Grenade / -Melee', categoryId: 'armor-mod-general' },
    };
    const result = classifyItem(statData.items[309000506], moved);
    expect(result?.categoryId).toBe('armor-mod-general');
    expect(result?.ruleId).toBe('manifest-armor-stat');
    expect(result?.excluded).toBe(true);
  });
});

describe('Artifact Perks', () => {
  // Real manifest hashes (manifest-facts.json): Armorsmith is offered by the sockets of Encrypted
  // Data Disk and Queensfoil Censer, Dielectric by Encrypted Data Disk only, and Unstoppable Bow
  // by no current artifact (an earlier Implement of Curiosity definition).
  const perk = (hash: number, name: string) => item(hash, name, 'armor-mod-seasonal');
  const artifactData = {
    ...data,
    categories: [
      ...categories,
      { id: 'armor-mod-seasonal', label: 'Armor Mod Seasonal', group: 'Armor', order: 50 },
    ].map((category) => ({ ...category, ...categoryDisplay(category.id) })),
    items: {
      2903198437: perk(2903198437, 'Armorsmith'),
      2903198438: perk(2903198438, 'Dielectric'),
      4217417021: perk(4217417021, 'Unstoppable Bow'),
      12: item(12, 'Ordinary Mod', 'armor-mod-general'),
    },
  } as unknown as EditorData;

  it('is its own category, outside Armor', () => {
    const groups = navigationGroups(artifactData, '');
    const owner = groups.find((group) => group.sections.some((s) => s.id === 'armor-mod-seasonal'));
    expect(owner?.name).toBe('Artifact');
    expect(groups.map((group) => group.name)).toEqual(['Armor', 'Artifact']);
    expect(section('armor-mod-seasonal', artifactData)?.label).toBe('Artifact Perks');
  });

  it('groups by owning artifact, newest first, and lists a shared perk under each', () => {
    const grouped = groupedSection(section('armor-mod-seasonal', artifactData)!, artifactData)!;
    expect(grouped.groups.map((group) => [group.id, group.label, names(group.entries)])).toEqual([
      ['1014202826', 'Encrypted Data Disk', [2903198437, 2903198438]],
      ['3518286241', 'Queensfoil Censer', [2903198437]],
      ['none', 'No current artifact', [4217417021]],
    ]);
    expect(grouped.owners.get(2903198437)?.map((group) => group.label)).toEqual([
      'Encrypted Data Disk',
      'Queensfoil Censer',
    ]);
    expect(grouped.firstGroup.get(2903198437)).toBe('1014202826');
    expect(grouped.allLabel).toBe('All artifacts');
    expect(grouped.groupLabel).toBe('Artifact');
  });

  it('orders artifacts newest season first, an unregistered (newer) artifact before them all', () => {
    const known = Object.entries(artifactSeasons)
      .sort(([, a], [, b]) => b - a)
      .map(([hash]) => artifactOrder(Number(hash)));
    expect(known).toEqual([...known].sort((a, b) => a - b));
    expect(Object.keys(artifactSeasons).map(Number).sort()).toEqual(
      [23349941, 1014202826, 1504442987, 3518286241, 2180638678, 1770364095, 3821685388].sort(),
    );
    expect(artifactOrder(42)).toBeLessThan(Math.min(...known));
    expect(artifactOrder(undefined)).toBeGreaterThan(Math.max(...known));
  });
});
