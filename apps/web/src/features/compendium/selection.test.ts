import { afterEach, expect, it, vi } from 'vitest';
import {
  resolveCompendiumLink,
  selectCompendiumCells,
  snapshotCompendium,
  type CompendiumData,
  type CompendiumMatch,
  type Tooltip,
} from '@clarity/core';
import { confirmCompendiumSelection } from './selection';
import { compendiumEnricher } from '../../services/save/enrichers/compendium';
import { loadCompendium } from '../../services/compendium';
vi.mock('../../services/compendium', () => ({ loadCompendium: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const cell = (text: string) => ({ plain: text, runs: [{ text, bold: true as const }] });
const base: Tooltip = {
  hash: 123,
  associated: [],
  text: { en: { text: 'English', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } },
};
async function englishSave(link: NonNullable<Tooltip['compendium']>, data: CompendiumData) {
  vi.mocked(loadCompendium).mockResolvedValue(data);
  const before = { ...base, compendium: link };
  return compendiumEnricher({
    before,
    next: { ...before, text: { en: { ...base.text.en!, text: 'Edited' } } },
  });
}
it('confirms an offered category row, combines same-category sections, and permits English save', async () => {
  const tab = {
    gid: '1662574278',
    name: 'Weapon Perks',
    rows: ['Weapon Traits', 'Intrinsic Traits', 'Glaive Information'].map((section, i) => ({
      name: 'Test',
      nameNorm: 'test',
      section,
      rowIndex: 10 + i * 10,
      anchor: { row: 10 + i * 10, col: 0 },
      cell: cell(section),
    })),
  };
  const data = { fetchedAt: '2026-10-31T00:00:00Z', tabs: [tab] };
  const ambiguous = resolveCompendiumLink(
    { ...snapshotCompendium({ tab, row: tab.rows[0] }), section: undefined },
    data,
  );
  expect(ambiguous.status).toBe('candidates');
  if (ambiguous.status !== 'candidates') throw new Error('Expected offered rows');
  for (const candidate of ambiguous.candidates) {
    // This is the same confirmation used by both the row picker and suggested rows.
    const link = confirmCompendiumSelection(candidate, data)!;
    expect(link).toBeDefined();
    expect(resolveCompendiumLink(link, data).status).toBe('ok');
    const saved = await englishSave(link, data);
    expect(saved.compendium?.snapshot).toEqual(link.snapshot);
    if (candidate.row.section === 'Weapon Traits') {
      expect(link.parts).toBeUndefined();
      expect(link.snapshot.plain).toBe('Weapon Traits');
    } else {
      expect(link.parts).toEqual(['Intrinsic Traits', 'Glaive Information']);
      expect(link.snapshot.plain).not.toContain('Weapon Traits');
    }
  }
});
it('previews duplicate arbitrary anchors but rejects acceptance; a nearby unique anchor follows movement', async () => {
  const tab = {
    gid: '1',
    name: 'Sheet',
    rows: [],
    grid: [
      { row: 10, col: 0, cell: cell('Anchor') },
      { row: 10, col: 1, cell: cell('first') },
      { row: 20, col: 0, cell: cell('Anchor') },
      { row: 20, col: 1, cell: cell('second') },
      { row: 9, col: 0, cell: cell('Unique nearby heading') },
    ],
  };
  const data = { fetchedAt: '2026-10-31T00:00:00Z', tabs: [tab] };
  function pick(row: number, name: string, dRow: number): CompendiumMatch {
    const anchor = { row, col: 0 };
    const cells = [{ dRow, dCol: 1 }];
    const preview = selectCompendiumCells(tab, anchor, cells)!;
    return {
      tab,
      row: { name, nameNorm: name.toLowerCase(), rowIndex: row, anchor, cell: preview },
      cells,
    };
  }
  for (const row of [10, 20]) {
    const selection = pick(row, 'Anchor', 0);
    expect(selection.row.cell.plain).toBe(row === 10 ? 'first' : 'second');
    expect(resolveCompendiumLink(snapshotCompendium(selection), data).status).toBe('candidates');
    expect(confirmCompendiumSelection(selection, data)).toBeUndefined();
  }
  const selection = pick(9, 'Unique nearby heading', 1);
  const link = confirmCompendiumSelection(selection, data)!;
  expect(resolveCompendiumLink(link, data)).toMatchObject({
    status: 'ok',
    row: { cell: cell('first') },
  });
  const moved = {
    ...data,
    tabs: [{ ...tab, grid: tab.grid.map((entry) => ({ ...entry, row: entry.row + 30 })) }],
  };
  expect(resolveCompendiumLink(link, moved).status).toBe('ok');
  expect((await englishSave(link, moved)).compendium?.cells).toEqual([{ dRow: 1, dCol: 1 }]);
});
