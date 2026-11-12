import { describe, expect, it } from 'vitest';
import type { SandboxPointers } from '@clarity/core';
import { buildRows, bulkCheck, effectivePick, matches, picksToSave, previewLine } from './model';
import { at, fixture } from './fixture.testSupport';

describe('worklist rows', () => {
  it('buckets every row and suggests a pick where one is safe to suggest', () => {
    const rows = buildRows(fixture());
    expect(rows.map((row) => [row.hash, row.bucket, row.suggestion])).toEqual([
      ['700', 'same-text', { to: 10 }],
      ['701', 'same-text', { to: 12 }],
      ['702', 'same-text', { to: 14 }],
      ['703', 'name-match', { to: 16 }],
      ['704', 'suggest-none', { none: true }],
      ['705', 'same-name', undefined],
      ['706', 'judgement', undefined],
    ]);
    expect(rows.find((row) => row.hash === '703')!.kind).toBe('armour');
  });

  it('flags a saved pick whose candidate set changed, and keeps retired picks undoable', () => {
    const rows = buildRows(
      fixture({
        version: 1,
        pointers: {
          700: { to: 10, candidates: [10], by: 1, at },
          701: { to: 12, candidates: [12, 13], by: 1, at },
          900: { none: true, candidates: [10, 12], by: 1, at },
        },
      }),
    );
    const byHash = Object.fromEntries(rows.map((row) => [row.hash, row]));
    expect(byHash['700']).toMatchObject({ changed: true, retired: false });
    expect(byHash['701']).toMatchObject({ changed: false });
    expect(byHash['900']).toMatchObject({ changed: true, retired: true });
    expect(matches(byHash['700']!, 'changed', '', '')).toBe(true);
    expect(matches(byHash['700']!, 'open', '', '')).toBe(false);
    expect(matches(byHash['700']!, 'decided', '', 'haste')).toBe(true);
    expect(matches(byHash['702']!, 'same-text', '', '702')).toBe(true);
  });

  it('builds the full set of picks a save sends from saved picks and staged changes', () => {
    const saved: SandboxPointers = {
      version: 1,
      pointers: {
        700: { to: 10, candidates: [10, 11], by: 1, at },
        701: { none: true, candidates: [12, 13], by: 1, at },
      },
    };
    const rows = buildRows(fixture(saved));
    const staged = { 701: null, 703: { to: 16 } };
    expect(picksToSave(saved, staged)).toEqual({ 700: { to: 10 }, 703: { to: 16 } });
    expect(
      effectivePick(
        rows.find((row) => row.hash === '701')!,
        staged,
      ),
    ).toBeUndefined();
    expect(
      effectivePick(
        rows.find((row) => row.hash === '700')!,
        staged,
      ),
    ).toEqual({ to: 10 });
  });
});

describe('compiled check for bulk accept', () => {
  it('applies only rows that compile the same in every language and in base and enhanced form', async () => {
    const input = fixture();
    const rows = buildRows(input).filter((row) => row.bucket === 'same-text');
    const result = await bulkCheck(
      rows,
      { tooltips: input.tooltips, aliases: input.aliases, cache: new Map() },
      undefined,
      async () => {},
    );
    expect(result.applied).toEqual(['701']);
    expect(result.skipped).toEqual([
      { hash: '700', name: 'Haste', reason: 'compiled output differs (de, base)' },
      { hash: '702', name: 'Haste', reason: 'compiled output differs (de, enhanced)' },
    ]);
  });
});

describe('Choose previews', () => {
  it('show the rendered first line, imports resolved, never raw markup', () => {
    const input = fixture();
    const context = { tooltips: input.tooltips, aliases: input.aliases, cache: new Map() };
    expect(previewLine(11, context)).toBe('Gain Haste.');
    expect(previewLine(13, context)).toBe('Gain Haste.');
    expect(previewLine(17, context)).toBe('Double dodge.');
    expect(previewLine(404, context)).toBe('');
  });
});
