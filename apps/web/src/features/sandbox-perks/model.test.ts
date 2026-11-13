import { describe, expect, it } from 'vitest';
import type { SandboxPointers, Tooltip } from '@clarity/core';
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

describe('suggestions and the compiled check match what consumers and the Worker accept', () => {
  const context = (input: ReturnType<typeof fixture>) => ({
    tooltips: input.tooltips,
    aliases: input.aliases,
    cache: new Map<string, string>(),
  });

  it('suggests a candidate, never an imported root outside the set', () => {
    const input = fixture();
    const t = (input.tooltips = structuredClone(input.tooltips) as Record<string, Tooltip>);
    // 11 and 13 both import a root (10 and 12) that is not a candidate.
    input.conflicts = { 700: [11, 13] };
    t[13] = { ...t[13]!, text: { ...t[11]!.text } };
    const [row] = buildRows(input);
    expect(row!.bucket).toBe('same-text');
    expect(row!.suggestion).toEqual({ to: 11 });
  });

  it('skips a row whose shared root does not compile (an unresolved import)', async () => {
    const input = fixture();
    const t = (input.tooltips = structuredClone(input.tooltips) as Record<string, Tooltip>);
    input.conflicts = { 700: [10, 11] };
    t[10]!.text = {
      en: { ...t[10]!.text.en!, text: 'import main from 12' },
    };
    t[11]!.text = {
      en: { ...t[11]!.text.en!, text: 'import main from 12' },
    };
    t[12]!.text.en!.text = 'Visible text.\nimport main from 99999';
    const result = await bulkCheck(buildRows(input), context(input));
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/^does not compile \(en, base\)/);
  });

  it('compiles imports with the stale-translation English fallback, as exported', async () => {
    const input = fixture();
    const t = (input.tooltips = structuredClone(input.tooltips) as Record<string, Tooltip>);
    // German: 10 and 11 import different documents with identical raw German text, but 14's
    // German is stale, so consumers get 14's (changed) English there.
    input.conflicts = { 700: [10, 11] };
    const de = (text: string, sourceUpdatedAt?: string) => ({
      text,
      updatedAt: '2026-10-01T00:00:00Z',
      updatedBy: 'fixture',
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    });
    t[10]!.text = {
      en: { ...t[10]!.text.en!, text: 'import main from 12' },
      de: de('import main from 14'),
    };
    t[11]!.text = {
      en: { ...t[11]!.text.en!, text: 'import main from 12' },
      de: de('import main from 15'),
    };
    t[14]!.text = {
      en: { text: 'Fallback changed.', updatedAt: '2026-11-12T00:00:00Z', updatedBy: 'fixture' },
      de: de('Gleich.', '2020-01-01T00:00:00Z'),
    };
    t[15]!.text = { en: { ...t[15]!.text.en! }, de: de('Gleich.') };
    const result = await bulkCheck(buildRows(input), context(input));
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('compiled output differs (de, base)');
  });
});
