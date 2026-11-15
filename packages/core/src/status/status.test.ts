import { describe, expect, it } from 'vitest';
import { exportLegacy, translationMaxAge, type LegacyEntry } from '../exportLegacy.js';
import type { Tooltip } from '../schemas.js';
import {
  bungieDrift,
  outdatedTranslations,
  translationQueue,
  translationStateOf,
} from './index.js';

const source = '2026-01-01T00:00:00.000Z';
function tooltip(hash: number, age = 1): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: {
        text: 'English',
        updatedAt: new Date(Date.parse(source) + age).toISOString(),
        updatedBy: 'e',
      },
      de: { text: 'Deutsch', updatedAt: source, updatedBy: 'd', sourceUpdatedAt: source },
    },
  };
}

describe('Bungie drift', () => {
  it('compares exact manifest text, counts missing snapshots and ignores absent manifest records', () => {
    const same = { ...tooltip(1), bungieSnapshot: { description: '', snapshotAt: source } };
    const changed = { ...tooltip(2), bungieSnapshot: { description: 'old', snapshotAt: source } };
    expect(
      bungieDrift([same, changed, tooltip(3), tooltip(4)], {
        1: { inGameDescription: '' },
        2: { inGameDescription: 'new' },
        3: { inGameDescription: 'no snapshot' },
      }),
    ).toEqual({ changed: [{ tooltip: changed, description: 'new' }], missingSnapshots: 1 });
  });

  it('does not count frame or sandbox aliases independently', () => {
    expect(
      bungieDrift(
        [tooltip(1), tooltip(2)],
        {
          1: { inGameDescription: 'one' },
          2: { inGameDescription: 'two' },
        },
        { 2: { to: 1, kind: 'frame' } },
      ).missingSnapshots,
    ).toBe(1);
  });
});

describe('outdated translations', () => {
  it('matches export at the exact 90-day boundary and beyond, independent of wall-clock time', () => {
    const exact = tooltip(1, translationMaxAge);
    const over = tooltip(2, translationMaxAge + 1);
    const entries = outdatedTranslations([exact, over]);
    expect(entries.map((entry) => [entry.tooltip.hash, entry.exportedInEnglish])).toEqual([
      [2, true],
      [1, false],
    ]);
    const exported = exportLegacy([exact, over], Date.parse('2030-01-01T00:00:00.000Z')) as Record<
      string,
      LegacyEntry
    >;
    expect(exported[1].editor.de?.main).toBe('Deutsch');
    expect(exported[2].editor.de?.main).toBe('English');
  });

  it('ignores equal/newer/unknown source revisions and missing English', () => {
    const unknown = tooltip(3);
    delete unknown.text.de?.sourceUpdatedAt;
    const noEnglish = tooltip(4);
    delete noEnglish.text.en;
    expect(outdatedTranslations([tooltip(1, 0), tooltip(2, -1), unknown, noEnglish])).toEqual([]);
  });

  it('filters assigned languages, ignores aliases, and sorts oldest first with stable ties', () => {
    const values = [tooltip(4, 20), tooltip(3, 10), tooltip(2, 20), tooltip(1, 30)];
    expect(
      outdatedTranslations(values, ['de'], { 1: { to: 2, kind: 'sandbox' } }).map(
        (entry) => entry.tooltip.hash,
      ),
    ).toEqual([2, 4, 3]);
    expect(outdatedTranslations(values, ['en', 'fr'])).toEqual([]);
  });
});

describe('translation queue', () => {
  const rows = (
    values: Tooltip[],
    languages?: Parameters<typeof translationQueue>[1],
    aliases = {},
  ) =>
    translationQueue(values, languages, aliases).map(
      (entry) => [entry.tooltip.hash, entry.language, entry.state] as const,
    );
  function only(hash: number, age = 1, extra: Partial<Tooltip> = {}): Tooltip {
    const value = tooltip(hash, age);
    delete value.text.de;
    return { ...value, ...extra };
  }

  it('classifies missing, outdated and current per tooltip and language', () => {
    const outdated = tooltip(1, 5);
    const current = tooltip(2, 0);
    const missing = only(3);
    const unknownSource = tooltip(4, 5);
    delete unknownSource.text.de?.sourceUpdatedAt;
    expect(rows([current, missing, outdated, unknownSource], ['de'])).toEqual([
      [1, 'de', 'outdated'],
      [3, 'de', 'missing'],
      [2, 'de', 'current'],
      [4, 'de', 'current'],
    ]);
  });

  it('lists every selected non-English language and defaults to all of them', () => {
    expect(rows([only(1)], ['en', 'de', 'fr'])).toEqual([
      [1, 'de', 'missing'],
      [1, 'fr', 'missing'],
    ]);
    const all = translationQueue([only(1)]);
    expect(all.length).toBeGreaterThan(2);
    expect(all.some((entry) => entry.language === 'en')).toBe(false);
    expect(translationQueue([only(1)], [])).toEqual([]);
  });

  it('uses the strict 90-day boundary like export and outdatedTranslations', () => {
    const exact = tooltip(1, translationMaxAge);
    const over = tooltip(2, translationMaxAge + 1);
    const entries = translationQueue([exact, over], ['de']);
    expect(entries.map((entry) => [entry.tooltip.hash, entry.exportedInEnglish])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(entries[0]).toMatchObject({ state: 'outdated', ageMs: translationMaxAge + 1 });
    expect(entries[0].sourceUpdatedAt).toBe(source);
    expect(entries).toEqual(
      outdatedTranslations([exact, over], ['de']).map((entry) => expect.objectContaining(entry)),
    );
  });

  it('never lists aliases or tooltips without English, but includes custom tooltips', () => {
    const noEnglish = only(3);
    delete noEnglish.text.en;
    const custom = only(4, 1, { custom: { name: 'Custom', categoryId: 'custom' } });
    expect(
      rows([only(1), only(2), noEnglish, custom], ['de'], { 2: { to: 1, kind: 'sandbox' } }),
    ).toEqual([
      [1, 'de', 'missing'],
      [4, 'de', 'missing'],
    ]);
  });

  it('sorts outdated by gap, then missing, then current with stable ties', () => {
    const values = [tooltip(5, 0), only(4), tooltip(3, 10), tooltip(2, 20), only(1)];
    expect(rows(values, ['de'])).toEqual([
      [2, 'de', 'outdated'],
      [3, 'de', 'outdated'],
      [1, 'de', 'missing'],
      [4, 'de', 'missing'],
      [5, 'de', 'current'],
    ]);
  });
});

describe('removed English numbers in the translation queue', () => {
  it.each(['old', 'current', 'unknown'] as const)(
    'flags a frozen token with %s source stamps until removed',
    (stamp) => {
      const value = tooltip(42, 1000);
      value.text.en!.numbers = { ids: [], next: 2, retired: { 1: '5' } };
      value.text.de!.text = 'Hält #{=1} Sekunden.';
      value.text.de!.sourceUpdatedAt =
        stamp === 'current' ? value.text.en!.updatedAt : stamp === 'unknown' ? undefined : source;
      expect(translationStateOf(value, 'de')).toMatchObject({
        state: 'outdated',
        reason: 'numbers',
        exportedInEnglish: false,
      });
      expect(translationQueue([value], ['de'])[0]).toMatchObject({
        state: 'outdated',
        reason: 'numbers',
      });
      value.text.de!.text = 'Hält an.';
      expect(translationStateOf(value, 'de').reason).toBeUndefined();
      expect(translationStateOf(value, 'de').state).toBe(stamp === 'old' ? 'outdated' : 'current');
    },
  );
  it('flags unfreezable and language-specific frozen formulas with the real export fallback', () => {
    const value = tooltip(42);
    value.text.de!.text = '#{=1}';
    for (const frozen of [null, { value: '${5+10}', fallback: ['de' as const] }]) {
      value.text.en!.numbers = { ids: [], next: 2, retired: { 1: frozen } };
      expect(translationStateOf(value, 'de')).toMatchObject({
        reason: 'numbers',
        exportedInEnglish: true,
      });
    }
  });
  it('keeps carried live tokens current, and ignores unreferenced retired ids', () => {
    const value = tooltip(42);
    value.text.en!.text = 'Grants 6 stacks.';
    value.text.en!.numbers = { ids: [2], next: 3, retired: { 1: '5' } };
    value.text.de!.text = '#{=2} Stapel';
    value.text.de!.sourceUpdatedAt = value.text.en!.updatedAt;
    expect(translationStateOf(value, 'de')).toEqual({ state: 'current' });
    delete value.text.de;
    expect(translationStateOf(value, 'de')).toEqual({ state: 'missing' });
  });
});
