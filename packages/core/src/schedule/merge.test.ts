import { describe, expect, it } from 'vitest';
import type { Tooltip } from '../schemas.js';
import {
  activate,
  changedFields,
  compose,
  existsField,
  missingSnapshotReason,
  nonTranslationChanges,
  resolveActivation,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';
const entry = (text: string, updatedAt = T0, extra: object = {}) => ({
  text,
  updatedAt,
  updatedBy: 'a',
  ...extra,
});

const omit = (text: Tooltip['text'], lang: keyof Tooltip['text']) =>
  Object.fromEntries(Object.entries(text).filter(([key]) => key !== lang)) as Tooltip['text'];

/** A published tooltip: English, German, French, two associations. */
const live: Tooltip = {
  hash: 7,
  text: {
    en: entry('Old'),
    de: entry('Alt', T0, { sourceUpdatedAt: T0 }),
    fr: entry('Vieux', T0, { sourceUpdatedAt: T0 }),
  },
  associated: [1, 2],
};
/** Current saved = live + unpublished saved work (custom name, Italian). */
const current: Tooltip = {
  ...live,
  custom: { name: 'Unpublished', categoryId: 'c' },
  text: { ...live.text, it: entry('Vecchio', T1, { sourceUpdatedAt: T0 }) },
};
/** The batch: new English, reworked German, one more association. */
const proposed: Tooltip = {
  ...current,
  text: { ...current.text, en: entry('New', T1), de: entry('Neu', T1, { sourceUpdatedAt: T1 }) },
  associated: [1, 2, 3],
};

describe('changed-field set (R17)', () => {
  it('is every merge3 key that differs, stamps ignored', () => {
    expect(changedFields(current, proposed)).toEqual(['text.en', 'text.de', 'associated']);
    expect(changedFields(current, current)).toEqual([]);
    const restamped: Tooltip = {
      ...current,
      text: {
        ...current.text,
        en: entry('Old', T2, { updatedBy: 'b' }),
        de: entry('Alt', T2, { sourceUpdatedAt: T2 }),
      },
      bungieSnapshot: undefined,
    };
    expect(changedFields(current, restamped)).toEqual([]);
    const snapA = { ...current, bungieSnapshot: { description: 'x', snapshotAt: T0 } };
    expect(
      changedFields(snapA, { ...snapA, bungieSnapshot: { description: 'x', snapshotAt: T2 } }),
    ).toEqual([]);
    expect(
      changedFields(snapA, { ...snapA, bungieSnapshot: { description: 'y', snapshotAt: T0 } }),
    ).toEqual(['bungieSnapshot']);
    expect(changedFields(current, { ...current, legacy: { uploadedBy: 'x' } })).toEqual(['legacy']);
    expect(changedFields(current, { ...current, associated: [2, 1] })).toEqual(['associated']);
    const withoutFr = omit(current.text, 'fr');
    expect(changedFields(current, { ...current, text: withoutFr })).toEqual(['text.fr']);
    expect(changedFields(null, { hash: 7, text: { en: entry('A') }, associated: [] })).toEqual([
      'text.en',
    ]);
    expect(nonTranslationChanges(current, proposed)).toEqual(['text.en', 'associated']);
  });
});

describe('composition C1-C4', () => {
  it('C1/C2: published snapshot + batch-changed fields only (golden)', () => {
    const result = compose({ hash: 7, base: current, proposed, snapshot: live, pushed: true });
    expect(result).toEqual({
      status: 'overlay',
      changed: ['text.en', 'text.de', 'associated'],
      tooltip: {
        hash: 7,
        text: {
          en: entry('New', T1),
          de: entry('Neu', T1, { sourceUpdatedAt: T1 }),
          fr: live.text.fr,
        },
        associated: [1, 2, 3],
      },
    });
    // I3: the saved-but-unpublished custom name and Italian never publish through the batch.
    if (result.status !== 'overlay') throw new Error();
    expect(result.tooltip.custom).toBeUndefined();
    expect(result.tooltip.text.it).toBeUndefined();
  });
  it('C2 removes a field the batch removed', () => {
    const text = omit(proposed.text, 'fr');
    const result = compose({
      hash: 7,
      base: current,
      proposed: { ...proposed, text },
      snapshot: live,
      pushed: true,
    });
    expect(result.status === 'overlay' && result.tooltip.text.fr).toBeUndefined();
  });
  it('C3: pushed without a snapshot is stale', () => {
    expect(compose({ hash: 7, base: current, proposed, snapshot: null, pushed: true })).toEqual({
      status: 'stale',
      reason: missingSnapshotReason,
    });
  });
  it('C4: never published, or created by the batch, publishes the whole proposal', () => {
    expect(compose({ hash: 7, base: current, proposed, snapshot: null, pushed: false })).toEqual({
      status: 'whole',
      tooltip: proposed,
      changed: ['text.en', 'text.de', 'associated'],
    });
    const created: Tooltip = { hash: 9, text: { en: entry('Brand new') }, associated: [] };
    expect(
      compose({ hash: 9, base: null, proposed: created, snapshot: null, pushed: false }),
    ).toMatchObject({
      status: 'whole',
      tooltip: created,
    });
  });
  it('refuses tooltips of another hash', () => {
    expect(() =>
      compose({ hash: 8, base: current, proposed, snapshot: live, pushed: true }),
    ).toThrow();
  });
});

describe('activation (I4, Q4, R14, R17)', () => {
  it('applies only batch-changed fields and keeps concurrent current work', () => {
    const later: Tooltip = {
      ...current,
      text: { ...current.text, it: entry('Nuovo', T2, { sourceUpdatedAt: T0 }) },
    };
    const result = activate({ base: current, current: later, proposed });
    expect(result).toEqual({
      ok: true,
      created: false,
      changed: ['text.en', 'text.de', 'associated'],
      tooltip: { ...proposed, text: { ...proposed.text, it: later.text.it } },
    });
  });
  it('a concurrent change to a changed non-translation field is a conflict', () => {
    const later: Tooltip = { ...current, text: { ...current.text, en: entry('Other', T2) } };
    expect(activate({ base: current, current: later, proposed })).toEqual({
      ok: false,
      fields: ['text.en'],
      changed: ['text.en', 'text.de', 'associated'],
    });
  });
  it('Q4: a translation the batch changed wins over a later current edit', () => {
    const later: Tooltip = {
      ...current,
      text: { ...current.text, de: entry('Anders', T2, { sourceUpdatedAt: T0 }) },
    };
    const result = activate({ base: current, current: later, proposed });
    expect(result.ok && result.tooltip.text.de).toEqual(proposed.text.de);
    // A translation the batch removed is removed even if current edited it.
    const text = omit(proposed.text, 'de');
    const removed = activate({ base: current, current: later, proposed: { ...proposed, text } });
    expect(removed.ok && removed.tooltip.text.de).toBeUndefined();
  });
  it('a language the batch did not change keeps current', () => {
    const later: Tooltip = {
      ...current,
      text: { ...current.text, fr: entry('Autre', T2, { sourceUpdatedAt: T0 }) },
    };
    const result = activate({ base: current, current: later, proposed });
    expect(result.ok && result.tooltip.text.fr).toEqual(later.text.fr);
  });
  it('a stamp-only difference never activates and never conflicts', () => {
    const restamped: Tooltip = {
      ...current,
      text: { ...current.text, fr: entry('Vieux', T2, { sourceUpdatedAt: T2 }) },
    };
    const later: Tooltip = {
      ...current,
      text: { ...current.text, fr: entry('Autre', T2, { sourceUpdatedAt: T0 }) },
    };
    const result = activate({ base: current, current: later, proposed: restamped });
    expect(result).toEqual({ ok: true, created: false, changed: [], tooltip: later });
  });
  it('merges associations with merge3 rules', () => {
    const later: Tooltip = { ...current, associated: [2, 1, 4] };
    const result = activate({ base: current, current: later, proposed });
    expect(result.ok && result.tooltip.associated).toEqual([1, 2, 3, 4]);
  });
  it('legacy and bungieSnapshot follow merge3 (R17)', () => {
    const base: Tooltip = { ...current, bungieSnapshot: { description: 'd', snapshotAt: T0 } };
    const next: Tooltip = {
      ...base,
      bungieSnapshot: { description: 'e', snapshotAt: T1 },
      legacy: { uploadedBy: 'x' },
    };
    const same = activate({
      base,
      current: { ...base, bungieSnapshot: { description: 'e', snapshotAt: T2 } },
      proposed: next,
    });
    // Both sides made the same content change: merge3 keeps current's stamp.
    expect(same.ok && same.tooltip.bungieSnapshot).toEqual({ description: 'e', snapshotAt: T2 });
    expect(same.ok && same.tooltip.legacy).toEqual({ uploadedBy: 'x' });
    const other = activate({
      base,
      current: { ...base, bungieSnapshot: { description: 'f', snapshotAt: T2 } },
      proposed: next,
    });
    expect(other).toMatchObject({ ok: false, fields: ['bungieSnapshot'] });
    const legacy = activate({
      base,
      current: { ...base, legacy: { uploadedBy: 'y' } },
      proposed: next,
    });
    expect(legacy).toMatchObject({ ok: false, fields: ['legacy'] });
  });
  it('existence rule (R14)', () => {
    const created: Tooltip = { hash: 9, text: { en: entry('Brand new') }, associated: [] };
    expect(activate({ base: null, current: null, proposed: created })).toEqual({
      ok: true,
      created: true,
      tooltip: created,
      changed: ['text.en'],
    });
    expect(activate({ base: null, current: created, proposed: created })).toMatchObject({
      ok: false,
      fields: [existsField],
    });
    expect(activate({ base: current, current: null, proposed })).toMatchObject({
      ok: false,
      fields: [existsField],
    });
  });
});

describe('resolution (R4, R12)', () => {
  const later: Tooltip = {
    ...current,
    custom: { name: 'Renamed', categoryId: 'c' },
    text: {
      ...current.text,
      en: entry('Other', T2),
      de: entry('Anders', T2, { sourceUpdatedAt: T0 }),
    },
  };
  it('requires a choice for every conflicted field', () => {
    expect(resolveActivation({ base: current, current: later, proposed, choices: {} })).toEqual({
      ok: false,
      missing: ['text.en'],
    });
  });
  it('mixed English and translation changes: clean fields take the batch value', () => {
    const result = resolveActivation({
      base: current,
      current: later,
      proposed,
      choices: { 'text.en': 'current' },
    });
    expect(result).toEqual({
      ok: true,
      tooltip: { ...later, text: { ...later.text, de: proposed.text.de }, associated: [1, 2, 3] },
    });
    const upcoming = resolveActivation({
      base: current,
      current: later,
      proposed,
      choices: { 'text.en': 'upcoming' },
    });
    expect(upcoming.ok && upcoming.tooltip?.text.en).toEqual(proposed.text.en);
  });
  it('all-current choices keep current entirely', () => {
    const choices = { 'text.en': 'current', 'text.de': 'current', associated: 'current' } as const;
    expect(resolveActivation({ base: current, current: later, proposed, choices })).toEqual({
      ok: true,
      tooltip: later,
    });
  });
  it('a field that newly conflicts after RECORD needs a choice', () => {
    // The conflict file listed text.en; then current's custom name moved while the batch renames it too.
    const next: Tooltip = { ...proposed, custom: { name: 'Batch', categoryId: 'c' } };
    const result = resolveActivation({
      base: current,
      current: later,
      proposed: next,
      choices: { 'text.en': 'current' },
    });
    expect(result).toEqual({ ok: false, missing: ['custom'] });
    // Associations never conflict: merge3 merges them as sets.
    const edited: Tooltip = { ...later, associated: [2] };
    const merged = resolveActivation({
      base: current,
      current: edited,
      proposed,
      choices: { 'text.en': 'current' },
    });
    expect(merged.ok && merged.tooltip?.associated).toEqual([2, 3]);
  });
  it('several non-language changes', () => {
    const next: Tooltip = {
      ...proposed,
      custom: { name: 'Batch', categoryId: 'c' },
      archive: undefined,
    };
    const result = resolveActivation({
      base: current,
      current: later,
      proposed: next,
      choices: { 'text.en': 'upcoming', custom: 'upcoming' },
    });
    expect(result.ok && result.tooltip).toEqual({
      ...next,
      text: { ...next.text, it: later.text.it },
    });
  });
  it('refuses choices outside the batch-changed fields, and resolves $exists', () => {
    expect(() =>
      resolveActivation({
        base: current,
        current: later,
        proposed,
        choices: { 'text.fr': 'upcoming' },
      }),
    ).toThrow(/does not change/);
    const created: Tooltip = { hash: 9, text: { en: entry('Brand new') }, associated: [] };
    const existing: Tooltip = { hash: 9, text: { en: entry('Someone else') }, associated: [] };
    expect(
      resolveActivation({ base: null, current: existing, proposed: created, choices: {} }),
    ).toEqual({
      ok: false,
      missing: [existsField],
    });
    expect(
      resolveActivation({
        base: null,
        current: existing,
        proposed: created,
        choices: { $exists: 'current' },
      }),
    ).toEqual({
      ok: true,
      tooltip: existing,
    });
    expect(
      resolveActivation({
        base: null,
        current: existing,
        proposed: created,
        choices: { $exists: 'upcoming' },
      }),
    ).toEqual({
      ok: true,
      tooltip: created,
    });
  });
});
