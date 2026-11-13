import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { compendiumEnricher } from './compendium';
import { changedSources, linksCompendium } from '../compendiumSource';
import { loadCompendium } from '../../compendium';
vi.mock('../../compendium', () => ({ loadCompendium: vi.fn() }));
const cell = { plain: 'current', runs: [{ text: 'current', color: '#6fa8dc' }] };
const data: CompendiumData = {
  fetchedAt: '2026-10-27T00:00:00Z',
  tabs: [
    {
      gid: '2',
      name: 'Moved tab',
      rows: [{ name: 'Test (Enhanced)', nameNorm: 'test', rowIndex: 8, cell }],
    },
  ],
};
const base: Tooltip = {
  hash: 123,
  associated: [],
  text: {
    en: { text: 'English', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' },
  },
  compendium: {
    gid: '1',
    rowKey: 'Test',
    snapshot: { plain: 'old', runs: [{ text: 'old' }] },
    snapshotAt: '2026-10-01T00:00:00Z',
  },
};
afterEach(() => {
  vi.clearAllMocks();
});
it('snapshots text/styles and follows a unique moved row only when English changes', async () => {
  vi.mocked(loadCompendium).mockResolvedValue(data);
  const next = { ...base, text: { en: { ...base.text.en!, text: 'Edited' } } };
  const result = await compendiumEnricher({ before: base, next });
  expect(result.compendium).toMatchObject({ gid: '2', rowKey: 'Test (Enhanced)', snapshot: cell });
  expect(result.compendium?.snapshotAt).not.toBe(base.compendium?.snapshotAt);
  expect(result.text).toBe(next.text);
  expect(base.compendium?.snapshot.plain).toBe('old');
});
it('never changes snapshots for translation-only saves, explicit reviews, or unlinked tooltips', async () => {
  const translated = { ...base, text: { ...base.text, de: { ...base.text.en!, text: 'Deutsch' } } };
  expect(await compendiumEnricher({ before: base, next: translated })).toBe(translated);
  const reviewed = { ...base, compendium: { ...base.compendium!, snapshot: cell } };
  expect(await compendiumEnricher({ before: base, next: reviewed })).toBe(reviewed);
  const unlinked = { ...base, compendium: undefined };
  expect(await compendiumEnricher({ before: base, next: unlinked })).toBe(unlinked);
  expect(loadCompendium).not.toHaveBeenCalled();
});
it('blocks missing/ambiguous links and upstream failures without clearing the old snapshot', async () => {
  const next = { ...base, text: { en: { ...base.text.en!, text: 'Edited' } } };
  vi.mocked(loadCompendium).mockResolvedValue({ ...data, tabs: [] });
  await expect(compendiumEnricher({ before: base, next })).rejects.toThrow('relinking');
  vi.mocked(loadCompendium).mockRejectedValue(new Error('HTTP 503'));
  await expect(compendiumEnricher({ before: base, next })).rejects.toThrow('HTTP 503');
  expect(base.compendium?.snapshot.plain).toBe('old');
});

it('preserves ordered human offsets on English saves and explicit review, leaving translations untouched', async () => {
  const cells = [{ dRow: 1, dCol: 1 }];
  const linked = {
    ...base,
    compendium: { ...base.compendium!, gid: '2', rowKey: 'Test (Enhanced)', cells },
  };
  const source = {
    ...data,
    tabs: [
      {
        ...data.tabs[0],
        rows: [{ ...data.tabs[0].rows[0], anchor: { row: 8, col: 0 } }],
        grid: [{ row: 9, col: 1, cell }],
      },
    ],
  };
  vi.mocked(loadCompendium).mockResolvedValue(source);
  const next = { ...linked, text: { en: { ...linked.text.en!, text: 'Edited' } } };
  const saved = await compendiumEnricher({ before: linked, next });
  expect(saved.compendium).toMatchObject({ cells, snapshot: cell });
  const translated = {
    ...linked,
    text: { ...linked.text, de: { ...linked.text.en!, text: 'Deutsch' } },
  };
  expect(await compendiumEnricher({ before: linked, next: translated })).toBe(translated);
  vi.mocked(loadCompendium).mockResolvedValue({ ...data, tabs: [{ ...source.tabs[0], grid: [] }] });
  await expect(compendiumEnricher({ before: linked, next })).rejects.toThrow('relinking');
  expect(linked.compendium.snapshot.plain).toBe('old');
});

it('records the pinned source the save panel showed instead of fetching another', async () => {
  const next = { ...base, text: { en: { ...base.text.en!, text: 'Edited' } } };
  const result = await compendiumEnricher({ before: base, next, compendium: data });
  expect(result.compendium).toMatchObject({ gid: '2', snapshot: cell });
  expect(loadCompendium).not.toHaveBeenCalled();
});

it('blocks similar renamed links on English save until the row is explicitly confirmed', async () => {
  const text = 'Grants increased damage for ten seconds.';
  const linked = {
    ...base,
    compendium: { ...base.compendium!, snapshot: { plain: text, runs: [{ text }] } },
  };
  const renamed = {
    ...data,
    tabs: [
      {
        ...data.tabs[0],
        rows: [
          {
            ...data.tabs[0].rows[0],
            name: 'Renamed',
            nameNorm: 'renamed',
            cell: { plain: text + '!', runs: [{ text: text + '!' }] },
          },
        ],
      },
    ],
  };
  const next = { ...linked, text: { en: { ...linked.text.en!, text: 'Edited' } } };
  await expect(compendiumEnricher({ before: linked, next, compendium: renamed })).rejects.toThrow(
    'relinking',
  );
  const confirmed = { ...next, compendium: { ...next.compendium, gid: '2', rowKey: 'Renamed' } };
  await expect(
    compendiumEnricher({ before: linked, next: confirmed, compendium: renamed }),
  ).resolves.toMatchObject({ compendium: { rowKey: 'Renamed' } });
});

describe('tag-only English edits review nothing in the Compendium', () => {
  const tagged = (text: string): Tooltip => ({
    ...base,
    text: { en: { ...base.text.en!, text } },
  });
  const plain = tagged('Burns with Scorch');
  const old = tagged('Burns with <solar/>Scorch');
  const inline = tagged('Burns with <solar Scorch />');
  const changes = (before: Tooltip, next: Tooltip) => [{ hash: 123, base: before, next }];
  // The cell moved and changed since the snapshot: only a real review may record it.
  const fresh = data;

  it.each([
    ['adds a tag', old, inline],
    ['removes a tag', inline, old],
    [
      'tags several spans',
      tagged('<void/>Volatile and <solar/>Scorch'),
      tagged('<void Volatile /> and <solar Scorch />'),
    ],
  ])(
    '%s: keeps the snapshot, fetches nothing, and asks for no acknowledgement',
    async (_, a, b) => {
      expect(await compendiumEnricher({ before: a, next: b })).toBe(b);
      expect(loadCompendium).not.toHaveBeenCalled();
      expect(linksCompendium(changes(a, b))).toBe(false);
      expect(changedSources(changes(a, b), null, fresh)).toEqual([]);
    },
  );

  it.each([
    ['a tag edit with a text change', old, tagged('Burns hotter with <solar Scorch />')],
    // An inserted icon is new output for every consumer, not tagging.
    ['an inserted icon', plain, old],
  ])('still snapshots %s', async (_, before, edited) => {
    vi.mocked(loadCompendium).mockResolvedValue(data);
    const result = await compendiumEnricher({ before, next: edited });
    expect(result.compendium).toMatchObject({ gid: '2', snapshot: cell });
    expect(linksCompendium(changes(before, edited))).toBe(true);
    expect(changedSources(changes(before, edited), null, fresh)).toEqual([
      { hash: 123, shown: base.compendium!.snapshot, fresh: cell },
    ]);
  });

  it('saves a tag-only edit on an unresolved link instead of asking to relink', async () => {
    vi.mocked(loadCompendium).mockResolvedValue({ ...data, tabs: [] });
    expect(await compendiumEnricher({ before: old, next: inline })).toBe(inline);
    const edited = tagged('Burns hotter with <solar Scorch />');
    await expect(compendiumEnricher({ before: old, next: edited })).rejects.toThrow('relinking');
  });
});
