import { expect, it } from 'vitest';
import { sourceMathFlags, styleLint } from './style.mjs';

it('rejects the final owner feedback patterns without rejecting a useful tick count', () => {
  for (const text of [
    'Benefits:\n• 10 Range',
    '<void Void Invisibility />.',
    'Solar Buffs and Strand Debuffs.',
    'Damage in a radius around the impact site.',
    'Restores its duration.',
    'Sprints for 0.03 seconds.',
  ])
    expect(styleLint(text), text).not.toEqual([]);
  expect(styleLint('Sprints for 0.03 seconds (one game tick).')).toEqual([]);
  expect(
    styleLint('Ticks for a total of 19 ticks over 10 seconds, dealing 32 damage per tick.'),
  ).toEqual([]);
  expect(styleLint('Deals a total of 640 damage.')).toContain('Style: total damage sum');
});

it('blocks repeated owner v4.8 misses before review', () => {
  for (const text of [
    'Upon scoring a kill, grants 5 Range.',
    'While active:',
    'After a 1 second delay, splits.',
    'Grants 2 stacks, up to 10 stacks.',
    'Retriggering refreshes the duration.',
    'Counts damage instances.',
    'Grants innate benefits.',
    'Deals a total of 10 damage.',
    'Allies in the field heal.',
    '1 Precision Angle Threshold',
    '4 Unravel seekers',
    'Decreased Accuracy Cone Growth',
  ])
    expect(styleLint(text), text).not.toEqual([]);
  expect(
    styleLint(
      'Grants the following benefits while hip-firing:\n• 5 Range\n• 5 Stability\n\nStacks up to 10 times.',
    ),
  ).toEqual([]);
  expect(styleLint('Releases 4 <strand Unravel /> seekers.')).toEqual([]);
});

it('rejects source phrasing even when markup splits its words', () => {
  for (const text of [
    'Throws your Grenade.',
    'With <primary/>Primary ammo, deals damage.',
    'Grants Fixed Grenade Ability Energy.',
    'Deals 5 damage over 8 meters.',
    'Applies <stasis Freeze />.',
    'Fire bursts of 5 projectiles.',
    'Dealing Additional damage.',
    '2x Vent Rate Multiplier.',
  ])
    expect(styleLint(text), text).not.toEqual([]);
  expect(styleLint('Consumes 1 Ammo to fire a burst of 5 projectiles.')).toEqual([]);
  expect(styleLint('Primary Ammo variants deal 20% increased direct damage.')).toEqual([]);
});
it('requires blank separators without splitting a list or its header', () => {
  expect(styleLint('Requires an Arc Super.\n3 Precision Hits Jolt the target.')).toContain(
    'Style: missing separator paragraph between prose blocks',
  );
  expect(styleLint('Kills grant energy. 3 second cooldown between activations.')).toContain(
    'Style: independent cooldown needs a separator paragraph',
  );
  expect(styleLint('Kills grant energy.\n#ChunkEnergyScalars')).toContain(
    'Style: missing separator paragraph before global disclaimer',
  );
  expect(
    styleLint(
      'Requires an Arc Super.\n\nGrants the following:\n• 10 Range\n• 5 Stability\n\n3 second cooldown between activations.\n\n#ChunkEnergyScalars',
    ),
  ).toEqual([]);
});
it('rejects bonus-form and units in fragment parentheses', () => {
  expect(styleLint('Lasts 2s (+2 seconds with <stasis Whisper of Durance />).')).toEqual(
    expect.arrayContaining([
      'Style: +X with fragment improvement',
      'Style: units in fragment improvement',
    ]),
  );
  expect(styleLint('Lasts 2s (4 with <stasis Whisper of Durance />).')).toEqual([]);
});
it('flags suspicious explicit tick totals without replacing the supplied numbers', () => {
  const item = {
    source: {
      text: 'Ticks up to 19 [?] times, dealing 32 [5?] Kinetic Damage every tick, totalling 640 [?] damage.',
    },
  };
  expect(sourceMathFlags(item)).toHaveLength(1);
  expect(item.source.text).toContain('640');
});
