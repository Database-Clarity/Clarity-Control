import { expect, test } from 'vitest';
import { exportLegacy, type Aliases, type Tooltip } from '@clarity/core';
import { conflictNotes, foldFrames } from './foldFrames.js';

const aliases: Aliases = {
  20: { to: 10, kind: 'frame' },
  30: { to: 10, kind: 'frame' },
  99: { to: 20, kind: 'sandbox' },
};
function tooltip(hash: number, text: string, day: number): Tooltip {
  return {
    hash,
    associated: [],
    text: { en: { text, updatedAt: `2026-10-${day}T00:00:00Z`, updatedBy: `author${hash}` } },
  };
}
test('equal texts keep canonical credits, remove aliases/markers, preserve other tooltips', () => {
  const source = [tooltip(10, 'same', 10), tooltip(20, 'same', 20), tooltip(40, 'other', 15)];
  source[1].associated = [99, 40];
  const result = foldFrames(source, aliases, { 10: 'a'.repeat(64), 20: 'b'.repeat(64) }, {});
  expect(result.tooltips.map((value) => value.hash)).toEqual([10, 40]);
  expect(result.tooltips[0].text.en?.updatedBy).toBe('author10');
  expect(result.tooltips[0].associated).toEqual([10, 40]);
  expect(result.pushed).toEqual({});
  expect(result.conflicts).toEqual([]);
  expect(source[1].associated).toEqual([99, 40]);
});
test('different texts choose latest per language and archive every replaced version losslessly', () => {
  const canonical = tooltip(10, 'old\n``` & text', 10);
  const newer = tooltip(20, 'new', 20);
  canonical.text.de = { ...canonical.text.en!, text: 'Deutsch', updatedAt: '2026-10-25T00:00:00Z' };
  newer.text.de = { ...newer.text.en!, text: 'alt' };
  const result = foldFrames(
    [canonical, newer, tooltip(30, 'middle', 15)],
    aliases,
    {},
    { 10: { name: 'Frame' } },
  );
  expect(result.tooltips[0].text.en).toEqual(newer.text.en);
  expect(result.tooltips[0].text.de).toEqual(canonical.text.de);
  expect(result.conflicts.map((value) => [value.hash, value.language])).toEqual([
    [30, 'en'],
    [10, 'en'],
    [20, 'de'],
  ]);
  expect(conflictNotes(result.conflicts)).toContain(JSON.stringify(canonical.text.en!.text));
  expect(conflictNotes(result.conflicts)).toContain('author10');
});
test('missing canonical is created and equal-time conflicts prefer canonical then lowest hash', () => {
  expect(foldFrames([tooltip(20, 'only', 20)], aliases, {}, {}).tooltips[0]).toMatchObject({
    hash: 10,
    text: { en: { text: 'only' } },
  });
  const result = foldFrames(
    [tooltip(20, 'other', 20), tooltip(10, 'canonical', 20)],
    aliases,
    {},
    {},
  );
  expect(result.tooltips[0].text.en?.text).toBe('canonical');
});
test('fold is idempotent and rejects cycles', () => {
  const result = foldFrames([tooltip(10, 'one', 10), tooltip(20, 'two', 20)], aliases, {}, {});
  expect(foldFrames(result.tooltips, aliases, result.pushed, {}).tooltips).toEqual(result.tooltips);
  expect(() =>
    foldFrames([], { 10: { to: 20, kind: 'frame' }, 20: { to: 10, kind: 'frame' } }, {}, {}),
  ).toThrow('Cyclic');
});

test.each(['', ' \n\t'])('nonempty text beats a newer blank %j in every language', (blank) => {
  const canonical = tooltip(10, blank, 25);
  const older = tooltip(20, 'restored', 10);
  canonical.text.de = { ...canonical.text.en!, text: blank };
  older.text.de = { ...older.text.en!, text: 'wiederhergestellt' };
  const result = foldFrames(
    [canonical, older, tooltip(30, 'latest nonempty', 20)],
    aliases,
    {},
    {},
  );
  expect(result.tooltips[0].text.en?.text).toBe('latest nonempty');
  expect(result.tooltips[0].text.de).toEqual(older.text.de);
  expect(result.conflicts).toContainEqual({
    canonical: 10,
    hash: 10,
    language: 'en',
    name: '10',
    value: canonical.text.en,
  });
  expect(canonical.text.en?.text).toBe(blank);
});

test('all-blank groups retain the normal revision/tie rules rather than inventing content', () => {
  const result = foldFrames([tooltip(10, '', 10), tooltip(20, ' ', 20)], aliases, {}, {});
  expect(result.tooltips[0].text.en?.text).toBe(' ');
  expect(result.tooltips[0].text.en?.updatedBy).toBe('author20');
});

test('a newer blank member cannot erase nonempty canonical text', () => {
  const canonical = tooltip(10, 'accepted shared text', 10);
  const result = foldFrames([canonical, tooltip(20, '', 25)], aliases, {}, {});
  expect(result.tooltips[0].text.en).toEqual(canonical.text.en);
});

test('owner-approved shared frames recover exact member text and export all aliases', () => {
  const groups = [
    { hash: 695966445, member: 1645158859, text: 'Hard-hitting four-burst fire.' },
    { hash: 570373697, member: 749936529, text: 'Hard-hitting two-burst fire.' },
    {
      hash: 1888623310,
      member: 1057935015,
      text: 'Superb handling. Move faster with this lightweight weapon equipped. This weapon grants additional speed benefits when MIDA Multi-Tool is also equipped.',
    },
  ];
  const frameAliases: Aliases = {};
  const source: Tooltip[] = [];
  for (const group of groups) {
    frameAliases[group.member] = { to: group.hash, kind: 'frame' };
    source.push(tooltip(group.hash, '', 25), tooltip(group.member, group.text, 10));
  }
  const result = foldFrames(source, frameAliases, {}, {});
  const exported = exportLegacy(result.tooltips, 0, undefined, frameAliases);
  for (const group of groups) {
    const canonical = result.tooltips.find((value) => value.hash === group.hash)!;
    expect(canonical.text.en?.text).toBe(group.text);
    expect(exported[group.member]).toMatchObject({ aliasOf: group.hash, aliasKind: 'frame' });
    expect(exported[group.hash]).toMatchObject({ editor: { en: { main: group.text } } });
  }
});
