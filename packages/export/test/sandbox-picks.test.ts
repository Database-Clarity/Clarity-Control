// Maintainer picks for shared sandbox perks (owner 2026-11-12) through the whole consumer chain:
// tooltips -> core exportLegacy with the merged aliases (what push-live and the publisher write to
// liveDescriptions.json) -> every legacy preset. With no picks every byte is v2's; with picks only
// clarityV2 gains `{hash, aliasOf}` references for the pointed perks, "no tooltip" picks are absent,
// and the seven deployed legacy files are unchanged (they skip sandbox aliases).
import { describe, expect, it } from 'vitest';
import {
  exportLegacy,
  mergeSandboxPointers,
  type Aliases,
  type LegacyCatalog,
  type SandboxConflicts,
  type SandboxPointers,
  type Tooltip,
} from '@clarity/core';
import {
  buildLegacy,
  deployedLegacyPresets,
  legacyPresets,
  type LegacyInput,
} from '../src/index.js';

const now = 1_762_000_000_000;
const text = (en: string): Tooltip['text'] => ({
  en: { text: en, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'fixture' },
  de: { text: `${en} (de)`, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'fixture' },
});
const tooltips: Tooltip[] = [
  // The reserved global libraries every converter run reads (exports, variables, titles).
  { hash: 1, text: text('// exports'), associated: [] },
  { hash: 2, text: text('// variables'), associated: [] },
  { hash: 3, text: text('// titles'), associated: [] },
  { hash: 101, text: text('Grants <solar/>Scorch on hit.'), associated: [] },
  { hash: 102, text: text('Reloads faster.'), associated: [] },
  { hash: 103, text: text('Different text.'), associated: [] },
];
const facts: LegacyCatalog = {
  1: { name: 'Global exports', type: 'none' },
  2: { name: 'Global variables', type: 'none' },
  3: { name: 'Global titles', type: 'none' },
  101: { name: 'Burning Rounds', type: 'Weapon Perk' },
  102: { name: 'Fast Hands', type: 'Weapon Perk' },
  103: { name: 'Third Perk', type: 'Weapon Perk' },
  201: { name: 'Burning Rounds', type: 'Weapon Perk' },
};
// Generator v2: one frame alias and one uncontested sandbox alias already exist.
const aliases: Aliases = { 201: { to: 101, kind: 'frame' }, 300: { to: 102, kind: 'sandbox' } };
const conflicts: SandboxConflicts = { 700: [101, 103], 701: [102, 103], 702: [101, 102] };
const at = '2026-11-12T20:00:00Z';
const picks: SandboxPointers = {
  version: 1,
  pointers: {
    700: { to: 101, candidates: [101, 103], by: 1, at },
    701: { none: true, candidates: [102, 103], by: 1, at },
    // Picked against an older candidate set: still applies (the worklist flags it Changed).
    702: { to: 102, candidates: [102], by: 1, at },
    // No longer shared (absent from the conflicts): ignored.
    703: { to: 103, candidates: [101, 103], by: 1, at },
  },
};
const input = (merged: Aliases) =>
  ({
    perks: exportLegacy(tooltips, now, facts, merged),
    databaseSettings: { folders: {}, enhancedPerks: {} },
  }) as unknown as LegacyInput;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('sandbox picks in consumer output', () => {
  const v2 = input(aliases);

  it('an empty picks file changes no byte of any output', () => {
    const empty = mergeSandboxPointers(aliases, conflicts, { version: 1, pointers: {} });
    expect(empty).toBe(aliases);
    // Only "no tooltip" picks: nothing to merge either.
    const noneOnly = mergeSandboxPointers(aliases, conflicts, {
      version: 1,
      pointers: { 701: picks.pointers['701']! },
    });
    expect(noneOnly).toBe(aliases);
    expect(JSON.stringify(input(empty))).toBe(JSON.stringify(v2));
    for (const preset of legacyPresets)
      expect(decode(buildLegacy(input(empty), preset)), preset).toBe(
        decode(buildLegacy(v2, preset)),
      );
  });

  it('picks add exactly the expected clarityV2 references and nothing else', () => {
    const merged = mergeSandboxPointers(aliases, conflicts, picks);
    expect(merged).toEqual({
      ...aliases,
      700: { to: 101, kind: 'sandbox' },
      702: { to: 102, kind: 'sandbox' },
    });
    const picked = input(merged);
    // liveDescriptions.json: the two stubs, nothing for "no tooltip" or the resolved perk.
    expect(picked.perks['700'] as unknown).toEqual({ hash: 700, aliasOf: 101, aliasKind: 'sandbox' });
    expect(picked.perks['702']).toEqual({ hash: 702, aliasOf: 102, aliasKind: 'sandbox' });
    expect(picked.perks).not.toHaveProperty('701');
    expect(picked.perks).not.toHaveProperty('703');
    expect(Object.keys(picked.perks).sort()).toEqual(
      [...Object.keys(v2.perks), '700', '702'].sort(),
    );

    const before = JSON.parse(decode(buildLegacy(v2, 'clarityV2'))) as Record<string, unknown>;
    const after = JSON.parse(decode(buildLegacy(picked, 'clarityV2'))) as Record<string, unknown>;
    const added = Object.keys(after).filter((key) => !(key in before));
    expect(added.sort()).toEqual(['700', '702']);
    expect(after['700']).toEqual({ hash: 700, aliasOf: 101 });
    expect(after['702']).toEqual({ hash: 702, aliasOf: 102 });
    for (const key of Object.keys(before)) expect(after[key], key).toEqual(before[key]);

    // The seven files at the old URLs skip sandbox aliases: byte-identical.
    for (const preset of deployedLegacyPresets)
      expect(decode(buildLegacy(picked, preset)), preset).toBe(decode(buildLegacy(v2, preset)));
  });
});
