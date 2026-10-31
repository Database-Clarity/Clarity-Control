import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { compendiumEnricher } from './compendium';
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
