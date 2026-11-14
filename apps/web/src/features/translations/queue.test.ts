import { describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { changeKey, changeSizeMemory } from './changeSize';
import type { Item } from '../../services/generator';
import {
  behindLabel,
  categoryOptions,
  countRows,
  filterRows,
  parseStateFilter,
  queueFor,
  translationIndex,
} from './queue';

// "Dormant" stands in for an item the Compendium classifies as Inactive & Placeholder.
vi.mock('../compendium/itemClassification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compendium/itemClassification')>();
  return {
    ...actual,
    classifyItem: (item: Item, tooltip?: Tooltip) =>
      item.name === 'Dormant'
        ? { categoryId: actual.inactiveCategory, ruleId: 'test', reason: '', excluded: true }
        : actual.classifyItem(item, tooltip),
  };
});

const stamp = { updatedBy: 'x' };
const english = '2026-03-01T00:00:00.000Z';
function tooltip(
  hash: number,
  en: string,
  translations: Record<string, { source?: string } | undefined> = {},
): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: en, updatedAt: english, ...stamp },
      ...Object.fromEntries(
        Object.entries(translations).map(([lang, entry]) => [
          lang,
          {
            text: `${lang} ${hash}`,
            updatedAt: '2026-01-01T00:00:00.000Z',
            ...stamp,
            ...(entry?.source ? { sourceUpdatedAt: entry.source } : {}),
          },
        ]),
      ),
    },
  };
}
const item = (hash: number, name: string, categoryId: string, extra: Partial<Item> = {}): Item => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...extra,
});

function fixture(): EditorData {
  const archived = {
    ...tooltip(7, 'Retired'),
    archive: {
      removedAt: '2026-02-01T00:00:00.000Z',
      lastSeen: { name: 'Gone', categoryId: 'perks', manifestVersion: 'v1' },
    },
  };
  const tooltips = [
    tooltip(1, 'Alpha text'),
    tooltip(2, 'Beta text', { de: { source: '2026-02-01T00:00:00.000Z' } }), // 28 days behind
    tooltip(3, 'Gamma text', { de: { source: english }, fr: {} }), // current
    tooltip(4, 'Alias text'),
    tooltip(5, 'Selector text'),
    tooltip(6, 'Dormant text'),
    archived,
    tooltip(8, '   '),
    tooltip(9, 'Nine text', { de: { source: '2025-12-01T00:00:00.000Z' } }), // 90 days behind
    tooltip(10, 'Ten text', { de: {} }), // no source revision: current
    tooltip(11, 'Eleven text', { de: { source: '2025-10-01T00:00:00.000Z' } }), // 151 days behind
    tooltip(12, 'Mod text'),
  ];
  return {
    categories: [
      { id: 'perks', label: 'Perks', group: 'Weapons', order: 2 },
      { id: 'mods', label: 'Mods', group: 'Armor', order: 1 },
    ],
    items: {
      1: item(1, 'Alpha', 'perks'),
      2: item(2, 'Beta', 'perks'),
      3: item(3, 'Gamma', 'perks'),
      4: item(4, 'Alias', 'perks'),
      5: item(5, 'Set Selector', 'perks', { hiddenFromEditor: true }),
      6: item(6, 'Dormant', 'perks'),
      7: item(7, 'Retired', 'perks'),
      8: item(8, 'Blank', 'perks'),
      9: item(9, 'Nine', 'perks'),
      10: item(10, 'Ten', 'perks'),
      11: item(11, 'Eleven', 'perks'),
      12: item(12, 'Mod Zulu', 'mods'),
    },
    aliases: { 4: { to: 1, kind: 'sandbox' } },
    bundle: {
      sourceCommit: 'abc',
      generatedAt: english,
      tooltips: Object.fromEntries(tooltips.map((entry) => [entry.hash, entry])),
      permissions: { users: {} },
      pushed: {},
    },
  };
}

describe('translation queue', () => {
  const data = fixture();
  const index = translationIndex(data);

  it('rebuilds the same small-changes order from cached English identities', () => {
    const tooltip = data.bundle.tooltips[2]!;
    const key = changeKey({
      hash: 2,
      sourceUpdatedAt: tooltip.text.de!.sourceUpdatedAt!,
      current: tooltip.text.en!.text,
    });
    changeSizeMemory.set(key, { count: 1 });
    try {
      expect(
        queueFor(index, 'de', { state: null, category: null, query: '', sort: 'small' })[0]?.hash,
      ).toBe(2);
    } finally {
      changeSizeMemory.delete(key);
    }
  });

  it('lists only translatable tooltips: no aliases, selectors, placeholders, archived, or blank English', () => {
    expect(index.translatable.map((entry) => entry.hash).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 9, 10, 11, 12,
    ]);
  });

  it('puts outdated first by largest English gap, then missing in finder order', () => {
    expect(index.queue('de').map((row) => [row.hash, row.state])).toEqual([
      [11, 'outdated'],
      [9, 'outdated'],
      [2, 'outdated'],
      [12, 'missing'], // Mods sorts before Perks
      [1, 'missing'],
    ]);
    expect(index.queue('de')[0]).toMatchObject({
      name: 'Eleven',
      category: 'Perks',
      key: '11:de',
      exportedInEnglish: true,
    });
    expect(index.queue('de')[2]!.exportedInEnglish).toBe(false);
  });

  it('treats translations without a source revision as translated and keeps languages apart', () => {
    expect(index.queue('fr').map((row) => row.hash)).toEqual([12, 1, 2, 11, 9, 10]);
    expect(index.queue('de').some((row) => row.hash === 10)).toBe(false);
    expect(index.queue('ja')).toHaveLength(7);
  });

  it('counts coverage per language from the same states', () => {
    expect(index.coverage('de')).toEqual({ translated: 2, outdated: 3, missing: 2 });
    expect(index.coverage('fr')).toEqual({ translated: 1, outdated: 0, missing: 6 });
    for (const language of ['de', 'fr', 'ja'] as const) {
      const rows = index.queue(language);
      const { translated, outdated, missing } = index.coverage(language);
      expect(countRows(rows)).toEqual({ outdated, missing });
      expect(translated + outdated + missing).toBe(index.translatable.length);
    }
  });

  it('counts coverage per category from the same states, summing to the total', () => {
    for (const language of ['de', 'fr', 'ja'] as const) {
      const total = index.coverage(language);
      const sum = { translated: 0, outdated: 0, missing: 0 };
      for (const { id } of index.categories) {
        const part = index.coverage(language, id);
        const rows = index.queue(language).filter((row) => row.categoryId === id);
        expect(countRows(rows)).toEqual({ outdated: part.outdated, missing: part.missing });
        sum.translated += part.translated;
        sum.outdated += part.outdated;
        sum.missing += part.missing;
      }
      expect(sum).toEqual(total);
      expect(index.coverage(language, null)).toBe(total);
      expect(index.coverage(language, 'no-such-category')).toEqual({
        translated: 0,
        outdated: 0,
        missing: 0,
      });
    }
    expect(index.coverage('de', 'mods')).toBe(index.coverage('de', 'mods'));
  });

  it('excludes paired and base-less enhanced parts from work queues and coverage, but keeps enhanced perks', () => {
    const data = fixture();
    const before = translationIndex(data);
    data.items[30] = item(30, 'Enhanced part', 'weapon-perk-enhanced', { baseHash: 1 });
    data.items[31] = item(31, 'Unpaired enhanced part', 'weapon-perk-enhanced');
    data.items[32] = item(32, 'Enhanced perk', 'weapon-trait-enhanced', { baseHash: 2 });
    data.bundle.tooltips[30] = tooltip(30, 'Enhanced part text');
    data.bundle.tooltips[31] = tooltip(31, 'Unpaired text', {
      de: { source: '2026-02-01T00:00:00.000Z' },
    });
    data.bundle.tooltips[32] = tooltip(32, 'Enhanced perk text');
    const index = translationIndex({ ...data });

    expect(index.translatable.map((entry) => entry.hash)).not.toContain(30);
    expect(index.translatable.map((entry) => entry.hash)).not.toContain(31);
    expect(index.translatable.map((entry) => entry.hash)).toContain(32);
    expect(index.queue('de').map((entry) => entry.hash)).not.toContain(30);
    expect(index.queue('de').map((entry) => entry.hash)).not.toContain(31);
    expect(index.coverage('de')).toEqual({
      ...before.coverage('de'),
      missing: before.coverage('de').missing + 1,
    });
  });

  it('is built once per loaded data set', () => {
    expect(translationIndex(data)).toBe(index);
    expect(translationIndex(fixture())).not.toBe(index);
    expect(index.queue('de')).toBe(index.queue('de'));
  });

  it('excludes paired enhanced mods from queues and coverage but keeps orphan enhanced mods', () => {
    const data = fixture();
    const before = translationIndex(data).coverage('de');
    data.items[40] = item(40, 'Base mod', 'weapon-mod');
    data.items[41] = item(41, 'Paired enhanced mod', 'weapon-mod-enhanced', { baseHash: 40 });
    data.items[42] = item(42, 'Orphan enhanced mod', 'weapon-mod-enhanced');
    data.bundle.tooltips[40] = tooltip(40, 'Base mod text');
    data.bundle.tooltips[41] = tooltip(41, 'Paired enhanced text', {
      de: { source: '2026-02-01T00:00:00.000Z' },
    });
    data.bundle.tooltips[42] = tooltip(42, 'Orphan enhanced text', {
      de: { source: '2026-02-01T00:00:00.000Z' },
    });
    const index = translationIndex({ ...data });
    expect(index.translatable.map((entry) => entry.hash)).not.toContain(41);
    expect(index.translatable.map((entry) => entry.hash)).toContain(42);
    expect(index.queue('de').map((row) => row.hash)).not.toContain(41);
    expect(index.queue('de').find((row) => row.hash === 42)?.state).toBe('outdated');
    expect(index.coverage('de')).toEqual({
      ...before,
      outdated: before.outdated + 1,
      missing: before.missing + 1,
    });
  });

  it('filters by state, category, and text', () => {
    const rows = index.queue('de');
    const hashes = (filters: Partial<Parameters<typeof filterRows>[1]>) =>
      filterRows(rows, { state: null, category: null, query: '', ...filters }).map((r) => r.hash);
    expect(hashes({})).toEqual([11, 9, 2, 12, 1]);
    expect(hashes({ state: 'outdated' })).toEqual([11, 9, 2]);
    expect(hashes({ state: 'missing' })).toEqual([12, 1]);
    expect(hashes({ category: 'mods' })).toEqual([12]);
    expect(hashes({ query: '  ELEVEN ' })).toEqual([11]);
    expect(hashes({ query: '12' })).toEqual([12]);
    expect(hashes({ query: 'perks' })).toEqual([11, 9, 2, 1]);
    expect(hashes({ state: 'missing', category: 'perks', query: 'alp' })).toEqual([1]);
    expect(hashes({ query: 'nothing' })).toEqual([]);
  });

  it('lists categories with rows in finder order', () => {
    expect(categoryOptions(index.queue('de'), index.categories)).toEqual([
      { id: 'mods', label: 'Mods', count: 1 },
      { id: 'perks', label: 'Perks', count: 4 },
    ]);
  });

  it('parses the state filter and words the gap briefly', () => {
    expect(['outdated', 'missing', 'all', '', null].map(parseStateFilter)).toEqual([
      'outdated',
      'missing',
      null,
      null,
      null,
    ]);
    const day = 86_400_000;
    expect([0.2, 3, 59, 60, 400, 900].map((days) => behindLabel(days * day))).toEqual([
      '1 d',
      '3 d',
      '59 d',
      '2 mo',
      '13 mo',
      '2 y',
    ]);
  });
});
