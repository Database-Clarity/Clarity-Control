import { expect, it } from 'vitest';
import { autoLinkCompendium } from '../../src/compendium/link.js';
import { compendiumIdentifiers, compendiumPreferredTabs } from '../../src/compendium/config.js';
import { normaliseCompendiumName } from '../../src/compendium/resolve.js';
import { publishableHash } from '../../src/publishableHash.js';
import type { CompendiumData } from '../../src/compendium/types.js';
const tooltip = {
  hash: 123,
  text: {
    en: {
      text: 'English',
      updatedAt: '2026-10-01T00:00:00Z',
      updatedBy: 'alice',
    },
  },
  associated: [],
};
const now = '2026-10-27T00:00:00Z';
const cell = {
  plain: 'Compendium styled cell',
  runs: [{ text: 'Compendium styled cell', color: '#6fa8dc' }],
};
const row = (name: string) => ({
  name,
  nameNorm: normaliseCompendiumName(name),
  rowIndex: 6,
  cell,
});
const data: CompendiumData = {
  fetchedAt: now,
  tabs: [
    {
      gid: '441434520',
      name: 'Exotic Weapons',
      rows: [row('Weapon name\nIntrinsic name\n↑Catalyst name')],
    },
  ],
};
it('links identifiers anywhere in a multiline name cell with metadata-only baselines', async () => {
  const result = autoLinkCompendium(
    tooltip,
    { 123: { hash: 123, name: 'Intrinsic name', categoryId: 'weapon-trait-exotic' } },
    {},
    data,
    now,
  );
  expect(result.reason).toBe('linked');
  expect(result.next?.compendium?.rowKey).toBe('Weapon name\nIntrinsic name\n↑Catalyst name');
  expect(await publishableHash(result.next!)).toBe(await publishableHash(tooltip));
});
it('uses aliases and base names without creating authored tooltips for alias hashes', () => {
  const items = {
    123: { hash: 123, name: 'Unknown', categoryId: 'weapon-trait-exotic' },
    999: { hash: 999, name: 'Intrinsic name', categoryId: 'weapon-trait-exotic' },
  };
  const aliases = { 999: { to: 123, kind: 'sandbox' as const } };
  expect(autoLinkCompendium(tooltip, items, aliases, data, now).reason).toBe('linked');
  expect(autoLinkCompendium({ ...tooltip, hash: 999 }, items, aliases, data, now).reason).toBe(
    'alias',
  );
});
it('never auto-links ambiguous or similarity-only matches and explains global/ghost exclusions', () => {
  const items = { 123: { hash: 123, name: 'Intrinsic name', categoryId: 'weapon-trait-exotic' } };
  expect(
    autoLinkCompendium(
      tooltip,
      items,
      {},
      { ...data, tabs: [{ ...data.tabs[0], rows: [...data.tabs[0].rows, ...data.tabs[0].rows] }] },
      now,
    ).reason,
  ).toBe('ambiguous');
  expect(
    autoLinkCompendium(tooltip, { 123: { ...items[123], name: 'Renamed' } }, {}, data, now).reason,
  ).toBe('unmatched');
  expect(autoLinkCompendium({ ...tooltip, hash: 2 }, {}, {}, data, now).reason).toBe(
    'no-equivalent',
  );
  expect(
    autoLinkCompendium(
      tooltip,
      { 123: { ...items[123], name: 'Other', categoryId: 'ghost-mod' } },
      {},
      data,
      now,
    ).reason,
  ).toBe('no-equivalent');
});
it.each([
  ['armor-mod-general', 'Set Bonus: \nWild Anthem', 'Wild Anthem\n\nLegacy Crucible Vendor'],
  ['armor-mod-general', 'Kinetic Siphon', 'Siphon\n[3 Energy]'],
  ['armor-mod-general', 'Heavy Ammo Finder', 'Ammo Finder\n[3 Energy]'],
  ['armor-mod-general', 'Special Ammo Scout', 'Ammo Scout\n[1 Energy]'],
  ['subclass-super', 'Silence and Squall', 'Silence & Squall'],
  ['subclass-grenade', 'Slicewire Grenade', 'Slicewire'],
  ['weapon-catalyst-exotic', 'Jade Rabbit Catalyst', 'The Jade Rabbit'],
  ['weapon-catalyst-exotic', 'Prometheus Catalyst', 'Prometheus Lens'],
  ['weapon-catalyst-exotic', 'Wardcliff Coil Catalyst', 'The Wardcliff Coil'],
  ['weapon-catalyst-exotic', 'Worldline Catalyst', 'Worldline Zero'],
  ['weapon-catalyst-exotic', 'Whisper Catalyst', 'Whisper of the Worm'],
  ['weapon-catalyst-exotic', 'Khvostov Catalyst', 'Khvostov 7G-0X'],
  ['weapon-catalyst-exotic', 'Acrius Catalyst', 'Legend of Acrius'],
  ['weapon-catalyst-exotic', 'Skyburner Catalyst', 'Skyburner\u2019s Oath'],
  ['weapon-catalyst-exotic', 'Colony Catalyst', 'The Colony'],
  ['weapon-catalyst-exotic', 'Prospector Catalyst', 'The Prospector'],
  ['weapon-frame-exotic', 'Cranial Spike', 'Dead Man\u2019s Tale\nCranial Spike I\u2013IV'],
  ['weapon-frame-exotic', 'Cranial Spike III', 'Dead Man\u2019s Tale\nCranial Spike I\u2013IV'],
  ['weapon-trait-exotic', 'Spinning Up', 'SUROS Regime\nSUROS Legacy\nSelectable Trait'],
  ['weapon-trait-exotic', 'Dual Speed Receiver', 'SUROS Regime\nSUROS Legacy\nSelectable Trait'],
  ['weapon-trait-exotic', 'Time-Slip', 'No Time to Explain\nRewind Again'],
  ['weapon-trait-exotic', 'Restorative Turret', 'Edge of Intent\nHealing Turret'],
  ['weapon-trait-exotic', 'The Scientific Method', 'Tractor Cannon\nScientific Method'],
  ['weapon-frame-exotic', 'Tri-Planar Mass Driver', 'Third Iteration\nTri-Planar Mass'],
  ['weapon-frame-exotic', 'Resurgence Directive III', 'Wolfsbane\nResurgence Directive'],
])('links evidenced category/name variants: %s / %s', (categoryId, name, sourceName) => {
  const result = autoLinkCompendium(
    tooltip,
    { 123: { hash: 123, name, categoryId } },
    {},
    { ...data, tabs: [{ ...data.tabs[0], rows: [row(sourceName)] }] },
    now,
  );
  expect(result.reason).toBe('linked');
  expect(result.next?.compendium?.rowKey).toBe(sourceName);
});
it('keeps bounded name variants conservative and prioritizes armor sets over ordinary mods', () => {
  expect(compendiumPreferredTabs('armor-mod-general', 'Set Bonus: \nWild Anthem')).toEqual([
    '1287885342',
  ]);
  expect(compendiumIdentifiers('Cranial Spike I\u2013IV')).not.toContain('Cranial Spike V');
  expect(compendiumIdentifiers('Cranial Spike IV\u2013I')).not.toContain('Cranial Spike');
  const source = { ...data, tabs: [{ ...data.tabs[0], rows: [row('Prometheus Lens')] }] };
  expect(
    autoLinkCompendium(
      tooltip,
      { 123: { hash: 123, name: 'Prometheus Catalyst', categoryId: 'weapon-perk' } },
      {},
      source,
      now,
    ).reason,
  ).toBe('unmatched');
});
it('prefers the full item name over shortened variants without hiding genuine ambiguity', () => {
  const items = { 123: { hash: 123, name: 'Storm Grenade', categoryId: 'subclass-grenade' } };
  const source = {
    ...data,
    tabs: [{ ...data.tabs[0], rows: [row('Storm Grenade'), row('Storm')] }],
  };
  const result = autoLinkCompendium(tooltip, items, {}, source, now);
  expect(result.reason).toBe('linked');
  expect(result.next?.compendium?.rowKey).toBe('Storm Grenade');
  expect(
    autoLinkCompendium(
      tooltip,
      items,
      {},
      {
        ...source,
        tabs: [{ ...source.tabs[0], rows: [row('Storm Grenade'), row('Storm Grenade')] }],
      },
      now,
    ).reason,
  ).toBe('ambiguous');
});
it.each(['unchanged', 'changed', 'moved', 'missing', 'ambiguous'])(
  'never re-snapshots or replaces an existing %s link during a baseline rerun',
  (status) => {
    const linked = {
      ...tooltip,
      compendium: {
        gid: '441434520',
        rowKey: 'Existing row',
        snapshot: cell,
        snapshotAt: now,
      },
    };
    const nextCell =
      status === 'changed'
        ? { plain: 'New upstream text', runs: [{ text: 'New upstream text' }] }
        : cell;
    const rows = status === 'missing' ? [] : [{ ...row('Existing row'), cell: nextCell }];
    if (status === 'ambiguous') rows.push({ ...rows[0], rowIndex: 7 });
    const current = {
      ...data,
      tabs: [{ ...data.tabs[0], gid: status === 'moved' ? '12345' : '441434520', rows }],
    };
    const result = autoLinkCompendium(
      linked,
      { 123: { hash: 123, name: 'Existing row', categoryId: 'weapon-trait-exotic' } },
      {},
      current,
      '2026-10-28T00:00:00Z',
    );
    expect(result.reason).toBe(
      status === 'missing' ? 'unmatched' : 'linked',
    );
    expect(result.next).toBeUndefined();
    expect(linked.compendium.snapshot).toEqual(cell);
    expect(linked.compendium.snapshotAt).toBe(now);
  },
);
