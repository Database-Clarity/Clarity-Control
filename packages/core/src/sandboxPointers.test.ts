import { describe, expect, it } from 'vitest';
import {
  applySandboxPicks,
  mergeSandboxPointers,
  sandboxPointerChanged,
  sandboxPointersSchema,
  type SandboxDecision,
  type SandboxPointers,
} from './sandboxPointers.js';
import { mergeLivePerks, type LegacyExportEntry } from './exportLegacy.js';

const at = '2026-11-12T20:00:00Z';
const conflicts = { 700: [101, 103], 701: [102, 103], 702: [101, 102] };

describe('mergeSandboxPointers', () => {
  it('returns the generator aliases object itself when nothing applies', () => {
    const aliases = { 5: { to: 101, kind: 'frame' as const } };
    expect(mergeSandboxPointers(aliases, conflicts, null)).toBe(aliases);
    expect(mergeSandboxPointers(aliases, conflicts, { version: 1, pointers: {} })).toBe(aliases);
    const none: SandboxPointers = {
      version: 1,
      pointers: { 700: { none: true, candidates: [101, 103], by: 1, at } },
    };
    expect(mergeSandboxPointers(aliases, conflicts, none)).toBe(aliases);
  });

  it('applies valid picks, keeps changed-set picks, and skips invalid ones', () => {
    const aliases = { 5: { to: 101, kind: 'frame' as const }, 9: { to: 5, kind: 'name' as const } };
    const pointers: SandboxPointers = {
      version: 1,
      pointers: {
        700: { to: 101, candidates: [101, 103], by: 1, at },
        701: { to: 102, candidates: [102], by: 1, at }, // set changed: still applies
        702: { to: 5, candidates: [101, 102], by: 1, at }, // target is an alias: skipped
        703: { to: 101, candidates: [101], by: 1, at }, // no longer shared: skipped
      },
    };
    const merged = mergeSandboxPointers(aliases, { ...conflicts }, pointers);
    expect(merged).toEqual({
      ...aliases,
      700: { to: 101, kind: 'sandbox' },
      701: { to: 102, kind: 'sandbox' },
    });
    expect(Object.keys(merged)).toEqual(['5', '9', '700', '701']);
    const decision = (hash: string) => pointers.pointers[hash] as SandboxDecision;
    expect(sandboxPointerChanged('700', decision('700'), conflicts)).toBe(false);
    expect(sandboxPointerChanged('701', decision('701'), conflicts)).toBe(true);
    expect(sandboxPointerChanged('703', decision('703'), conflicts)).toBe(true);
  });

  it('never merges a pick for a perk a generator alias points into', () => {
    const aliases = { 80: { to: 700, kind: 'frame' as const } };
    const pointers: SandboxPointers = {
      version: 1,
      pointers: { 700: { to: 101, candidates: [101, 103], by: 1, at } },
    };
    expect(mergeSandboxPointers(aliases, conflicts, pointers)).toBe(aliases);
  });

  it('never overrides a generator alias for the same hash', () => {
    const aliases = { 700: { to: 103, kind: 'sandbox' as const } };
    const pointers: SandboxPointers = {
      version: 1,
      pointers: { 700: { to: 101, candidates: [101, 103], by: 1, at } },
    };
    expect(mergeSandboxPointers(aliases, conflicts, pointers)).toBe(aliases);
  });
});

describe('sandbox picks file', () => {
  it('accepts exactly one of to and none', () => {
    const base = { candidates: [1, 2], by: 1, at };
    expect(
      sandboxPointersSchema.safeParse({ version: 1, pointers: { 7: { to: 1, ...base } } }).success,
    ).toBe(true);
    expect(
      sandboxPointersSchema.safeParse({ version: 1, pointers: { 7: { none: true, ...base } } })
        .success,
    ).toBe(true);
    // An undone tombstone carries who and when only.
    expect(
      sandboxPointersSchema.safeParse({
        version: 1,
        pointers: { 7: { state: 'undone', by: 1, at } },
      }).success,
    ).toBe(true);
    for (const pick of [
      { ...base },
      { to: 1, none: true, ...base },
      { none: false, ...base },
      { state: 'undone', to: 1, by: 1, at },
      { state: 'removed', by: 1, at },
    ])
      expect(sandboxPointersSchema.safeParse({ version: 1, pointers: { 7: pick } }).success).toBe(
        false,
      );
  });

  it('records who, when, and the current set only for new or changed picks', () => {
    const current: SandboxPointers = {
      version: 1,
      pointers: {
        700: { to: 101, candidates: [101], by: 7, at: '2026-11-01T00:00:00Z' },
        701: { none: true, candidates: [102, 103], by: 7, at: '2026-11-01T00:00:00Z' },
      },
    };
    const next = applySandboxPicks(
      current,
      { 702: { to: 102 }, 700: { to: 101 }, 701: { to: 103 } },
      conflicts,
      1,
      at,
    );
    expect(next).toEqual({
      version: 1,
      pointers: {
        700: current.pointers['700'],
        701: { to: 103, candidates: [102, 103], by: 1, at },
        702: { to: 102, candidates: [101, 102], by: 1, at },
      },
    });
    // Omitted decisions become undone tombstones (never erased); a tombstone stays as stored, and
    // picking the perk again is a new decision.
    const undone = applySandboxPicks(current, {}, conflicts, 1, at);
    expect(undone.pointers).toEqual({
      700: { state: 'undone', by: 1, at },
      701: { state: 'undone', by: 1, at },
    });
    const later = '2026-11-14T00:00:00Z';
    expect(applySandboxPicks(undone, { 700: { to: 101 } }, conflicts, 2, later).pointers).toEqual({
      700: { to: 101, candidates: [101, 103], by: 2, at: later },
      701: { state: 'undone', by: 1, at },
    });
  });
});

describe('mergeLivePerks', () => {
  const stub = (hash: number, aliasOf: number, aliasKind = 'sandbox') => ({
    hash,
    aliasOf,
    aliasKind,
  });
  const live = {
    101: { hash: 101, editor: {} },
    102: { hash: 102, editor: {} },
    700: stub(700, 101),
    701: stub(701, 102),
    // The generator's own sandbox stub it has since dropped; no pick names it.
    800: stub(800, 101),
    9: { hash: 9, editor: {} },
  };
  const entries = { 9: { hash: 9, editor: {} } } as unknown as Record<string, LegacyExportEntry>;

  it('without a picks file is exactly the v2 spread', () => {
    expect(mergeLivePerks(live, entries)).toEqual({ ...live, ...entries });
  });

  it('recomputes every key the picks file names, and only those', () => {
    // 700 undone (no alias now): absent. 701 retargeted to 101: its stub moves, though neither
    // 101 nor 102 is in this export. 702 picked to 101: written. 800 is not named: untouched.
    const aliases = {
      701: { to: 101, kind: 'sandbox' as const },
      702: { to: 101, kind: 'sandbox' as const },
    };
    const merged = mergeLivePerks(live, entries, { keys: ['700', '701', '702'], aliases });
    expect(merged).not.toHaveProperty('700');
    expect(merged['701']).toEqual(stub(701, 101));
    expect(merged['702']).toEqual(stub(702, 101));
    expect(merged['800']).toEqual(stub(800, 101));
  });

  it('gives a key back to the generator once it owns it, and never deletes a tooltip record', () => {
    const owned = { 700: { to: 102, kind: 'frame' as const } };
    const merged = mergeLivePerks({ ...live, 703: { hash: 703, editor: {} } }, entries, {
      keys: ['700', '703'],
      aliases: owned,
      catalog: { 700: { name: 'Frame', type: 'frame' } },
    });
    expect(merged['700']).toMatchObject({ hash: 700, aliasOf: 102, aliasKind: 'frame' });
    expect(merged['703']).toEqual({ hash: 703, editor: {} });
  });

  it('writes no stub whose target is not a live tooltip yet', () => {
    const merged = mergeLivePerks(live, entries, {
      keys: ['700'],
      aliases: { 700: { to: 555, kind: 'sandbox' } },
    });
    expect(merged).not.toHaveProperty('700');
  });
});
