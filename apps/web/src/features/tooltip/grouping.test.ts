import { describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { entryView, groupedPerks } from './grouping';

const item = (hash: number, name: string, categoryId: string, extra = {}) => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...extra,
});

function build(): EditorData {
  return {
    categories: [
      { id: 'weapon-trait', label: 'Trait', group: 'W', order: 1, legacyType: 'Weapon Trait' },
      {
        id: 'weapon-trait-enhanced',
        label: 'Enhanced',
        group: 'W',
        order: 2,
        legacyType: 'Weapon Trait Enhanced',
      },
      { id: 'weapon-frame', label: 'Frame', group: 'W', order: 3, legacyType: 'Weapon Frame' },
      { id: 'weapon-frame-exotic', label: 'Intrinsic', group: 'W', order: 4 },
    ],
    items: {
      // A trait, its enhanced pair, an alias group member, and an alias of the enhanced pair.
      10: item(10, 'Rampage', 'weapon-trait'),
      11: item(11, 'Rampage', 'weapon-trait-enhanced', { baseHash: 10 }),
      20: item(20, 'Rampage', 'weapon-trait'),
      21: item(21, 'Rampage', 'weapon-trait-enhanced'),
      // A legendary frame group.
      30: item(30, 'Adaptive Frame', 'weapon-frame'),
      31: item(31, 'Adaptive Frame', 'weapon-frame'),
      32: item(32, 'Adaptive Frame', 'weapon-frame'),
      // An exotic intrinsic and its numbered copy; the perk is shared by two exotics.
      40: item(40, 'Fan Fire', 'weapon-frame-exotic', {
        owners: [400, 401],
        ownerNames: { 400: 'Thorn', 401: 'Malfeasance' },
      }),
      41: item(41, 'Fan Fire II', 'weapon-frame-exotic'),
    },
    aliases: {
      20: { to: 10, kind: 'name' },
      21: { to: 11, kind: 'name' },
      31: { to: 30, kind: 'frame' },
      32: { to: 30, kind: 'frame' },
      41: { to: 40, kind: 'name' },
    },
    bundle: {
      sourceCommit: 'x',
      generatedAt: '2026-11-01T00:00:00Z',
      tooltips: {},
      permissions: { users: {} },
      pushed: {},
    },
  } as unknown as EditorData;
}

const summary = (hash: number, data: EditorData) =>
  groupedPerks(hash, data).map(({ hash, enhanced, reason }) => [hash, enhanced, reason]);

describe('groupedPerks', () => {
  const data = build();

  it('lists the canonical, its enhanced pair, and alias group members', () => {
    expect(summary(10, data)).toEqual([
      [10, false, 'canonical'],
      [11, true, 'enhanced'],
      [20, false, 'alias'],
      [21, true, 'alias'],
    ]);
  });

  it('is the same list from any hash of the entry', () => {
    for (const hash of [11, 20, 21]) expect(groupedPerks(hash, data)).toBe(groupedPerks(10, data));
  });

  it('lists a legendary frame group', () => {
    expect(summary(31, data)).toEqual([
      [30, false, 'canonical'],
      [31, false, 'frame'],
      [32, false, 'frame'],
    ]);
  });

  it('marks a numbered exotic intrinsic and names the owners of a shared perk', () => {
    expect(summary(41, data)).toEqual([
      [40, false, 'canonical'],
      [41, false, 'numbered'],
    ]);
    expect(groupedPerks(40, data)[0]).toMatchObject({
      name: 'Fan Fire',
      sharedBy: ['Thorn', 'Malfeasance'],
    });
  });

  it('marks a sandbox alias of the enhanced version as enhanced', () => {
    // Collective Pugilism: each version has its own sandbox perk; neither is a catalog item.
    const pugilism = build();
    pugilism.items[60] = item(60, 'Collective Pugilism', 'weapon-trait');
    pugilism.items[61] = item(61, 'Collective Pugilism', 'weapon-trait-enhanced', {
      baseHash: 60,
    });
    pugilism.aliases[600] = { to: 60, kind: 'sandbox' };
    pugilism.aliases[610] = { to: 61, kind: 'sandbox' };
    expect(summary(60, pugilism)).toEqual([
      [60, false, 'canonical'],
      [61, true, 'enhanced'],
      [600, false, 'sandbox'],
      [610, true, 'sandbox'],
    ]);
  });

  it('lists a lone perk as just its canonical', () => {
    const lone = build();
    lone.items[50] = item(50, 'Solo', 'weapon-trait');
    expect(summary(50, lone)).toEqual([[50, false, 'canonical']]);
  });
});

describe('entryView', () => {
  const view = (hash: number, data: EditorData) => {
    const { blocks, summary } = entryView(groupedPerks(hash, data), data);
    return {
      summary,
      blocks: blocks.map(({ title, rows }) => [
        title,
        rows.map((row) => [row.kind, row.hash, row.mark ?? row.joined ?? row.unattached?.why]),
      ]),
    };
  };
  /** Ancillary Ordinance: the base's only perk effect (600) is one its enhanced version lists too. */
  const ancillary = () => {
    const data = build();
    data.items[60] = item(60, 'Ancillary', 'weapon-trait', { sandboxPerkHashes: [600] });
    data.items[61] = item(61, 'Ancillary', 'weapon-trait-enhanced', {
      baseHash: 60,
      sandboxPerkHashes: [610, 600],
    });
    data.bundle.tooltips[60] = data.bundle.tooltips[61] = {
      text: { en: { text: 'Same' } },
    } as never;
    data.aliases[610] = { to: 61, kind: 'sandbox' };
    data.sandboxConflicts = { 600: [60, 61] };
    return data;
  };

  it('splits items and perk effects by version, with the unattached effect under both', () => {
    const missing = 'Not attached: used by base and enhanced';
    expect(view(60, ancillary())).toEqual({
      summary: '3 share this text: 2 items, 1 perk effect. 1 more perk effect is not attached.',
      blocks: [
        [
          'Base',
          [
            ['Item', 60, 'Text is here'],
            ['Perk effect', 600, missing],
          ],
        ],
        [
          'Enhanced',
          [
            ['Item', 61, undefined],
            ['Perk effect', 610, undefined],
            ['Perk effect', 600, missing],
          ],
        ],
      ],
    });
  });

  it('shows the effect once, under the base, when it is attached to the base', () => {
    const data = ancillary();
    data.aliases = { ...data.aliases, 600: { to: 60, kind: 'sandbox' } };
    data.sandboxConflicts = {};
    expect(view(60, data)).toEqual({
      summary: '4 share this text: 2 items, 2 perk effects.',
      blocks: [
        [
          'Base',
          [
            ['Item', 60, 'Text is here'],
            ['Perk effect', 600, 'Also used by enhanced'],
          ],
        ],
        [
          'Enhanced',
          [
            ['Item', 61, undefined],
            ['Perk effect', 610, undefined],
          ],
        ],
      ],
    });
  });

  it('says why else an effect is not attached, and whether it can be reviewed', () => {
    const why = (change: (data: EditorData) => void) => {
      const data = ancillary();
      change(data);
      const rows = entryView(groupedPerks(60, data), data).blocks[0]!.rows;
      return rows.find((row) => row.hash === 600)!.unattached;
    };
    expect(why((data) => (data.sandboxConflicts = { 600: [60, 61, 20, 30] }))).toEqual({
      why: 'Not attached: also used by 2 other entries',
      others: 'Rampage and Adaptive Frame',
      review: true,
    });
    // Grouped hashes are one other entry.
    expect(why((data) => (data.sandboxConflicts = { 600: [60, 20, 11] }))).toEqual({
      why: 'Not attached: also used by Rampage',
      review: true,
    });
    expect(
      why((data) => {
        data.items[70] = item(70, 'Ancillary', 'weapon-trait');
        data.sandboxConflicts = { 600: [60, 70] };
      }),
    ).toEqual({ why: 'Not attached: also used by Ancillary 70', review: true });
    expect(
      why((data) => {
        data.bundle.sandboxPointers = {
          version: 1,
          pointers: { 600: { none: true, candidates: [60, 61], by: 1, at: '' } },
        };
      }),
    ).toEqual({ why: 'Not attached: set to no tooltip', review: true });
    expect(why((data) => (data.aliases[600] = { to: 10, kind: 'sandbox' }))).toEqual({
      why: 'Attached to Rampage instead',
      review: true,
    });
    expect(why((data) => delete data.sandboxConflicts)).toEqual({
      why: 'Not attached: used by base and enhanced',
      review: false,
    });
  });

  it('marks an enhanced version that does not share the text', () => {
    const mark = (text: string) => {
      const data = ancillary();
      data.bundle.tooltips[61] = { text: { en: { text } } } as never;
      expect(view(60, data).summary).toMatch(/^3 are grouped here: /);
      return view(60, data).blocks[1]![1]![0];
    };
    expect(mark('Other')).toEqual(['Item', 61, 'Has its own text']);
    expect(mark('')).toEqual(['Item', 61, 'Has no text']);
  });

  it('names copies, frames, and the items of an entry with one version plainly', () => {
    const data = build();
    expect(view(40, data).blocks).toEqual([
      [
        '',
        [
          ['Item', 40, 'Text is here'],
          ['Item', 41, 'Numbered copy'],
        ],
      ],
    ]);
    expect(view(40, data).summary).toBe('2 share this text: 2 items.');
    expect(view(30, data).blocks[0]![0]).toBe('Base frames');
    data.items[50] = item(50, 'Solo', 'weapon-trait');
    expect(view(50, data).summary).toBe('Only 1 item uses this text.');
    expect(view(10, data).blocks[0]![1]).toContainEqual(['Item', 20, 'Same-name copy']);
    data.items[20] = item(20, 'Rampage', 'weapon-trait', { sandboxPerkHashes: [700] });
    data.sandboxConflicts = { 700: [10, 20] };
    expect(view(10, data).blocks[0]![1]).toContainEqual([
      'Perk effect',
      700,
      'Not attached: used by 2 items here',
    ]);
  });
});
