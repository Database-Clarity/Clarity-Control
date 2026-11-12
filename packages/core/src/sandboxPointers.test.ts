import { describe, expect, it } from 'vitest';
import {
  applySandboxPicks,
  mergeSandboxPointers,
  sandboxPointerChanged,
  sandboxPointersSchema,
  type SandboxPointers,
} from './sandboxPointers.js';

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
    expect(sandboxPointerChanged('700', pointers.pointers['700']!, conflicts)).toBe(false);
    expect(sandboxPointerChanged('701', pointers.pointers['701']!, conflicts)).toBe(true);
    expect(sandboxPointerChanged('703', pointers.pointers['703']!, conflicts)).toBe(true);
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
    for (const pick of [{ ...base }, { to: 1, none: true, ...base }, { none: false, ...base }])
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
    expect(Object.keys(applySandboxPicks(current, {}, conflicts, 1, at).pointers)).toEqual([]);
  });
});
