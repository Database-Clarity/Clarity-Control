import { describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { groupedPerks } from './grouping';

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
  groupedPerks(hash, data).map(({ hash, enhanced, reason, via }) => [hash, enhanced, reason, via]);

describe('groupedPerks', () => {
  const data = build();

  it('lists the canonical, its enhanced pair, and alias group members with what they join through', () => {
    expect(summary(10, data)).toEqual([
      [10, false, 'canonical', undefined],
      [11, true, 'enhanced', undefined],
      [20, false, 'alias', undefined],
      [21, true, 'alias', 11],
    ]);
  });

  it('is the same list from any hash of the entry', () => {
    for (const hash of [11, 20, 21]) expect(groupedPerks(hash, data)).toBe(groupedPerks(10, data));
  });

  it('lists a legendary frame group', () => {
    expect(summary(31, data)).toEqual([
      [30, false, 'canonical', undefined],
      [31, false, 'frame', undefined],
      [32, false, 'frame', undefined],
    ]);
  });

  it('marks a numbered exotic intrinsic and names the owners of a shared perk', () => {
    expect(summary(41, data)).toEqual([
      [40, false, 'canonical', undefined],
      [41, false, 'numbered', undefined],
    ]);
    expect(groupedPerks(40, data)[0]).toMatchObject({
      name: 'Fan Fire',
      sharedBy: ['Thorn', 'Malfeasance'],
    });
  });

  it('lists a lone perk as just its canonical', () => {
    const lone = build();
    lone.items[50] = item(50, 'Solo', 'weapon-trait');
    expect(summary(50, lone)).toEqual([[50, false, 'canonical', undefined]]);
  });
});
