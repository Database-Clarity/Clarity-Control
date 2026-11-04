import { expect, it } from 'vitest';
import {
  selectCompendiumCells,
  snapshotCompendium,
  type CompendiumCell,
  type CompendiumSheet,
} from '@clarity/core';
import { compactMatch, compactProposal } from './compactMatches';
import { confirmCompendiumSelection } from './selection';

it('keeps styled multi-cell link confirmation valid without duplicating the source grid', () => {
  const cell = (plain: string): CompendiumCell => ({
    plain,
    runs: [{ text: plain, bold: true }],
    background: '#123456',
  });
  const row = {
    name: 'Name',
    nameNorm: 'name',
    rowIndex: 2,
    anchor: { row: 2, col: 0 },
    cell: cell('Name'),
  };
  const tab: CompendiumSheet = {
    gid: 'g1',
    name: 'Tab',
    rows: [row],
    grid: [
      { row: 2, col: 0, cell: row.cell },
      { row: 2, col: 1, cell: cell('One') },
      { row: 3, col: 1, cell: cell('Two') },
    ],
  };
  const cells = [
    { dRow: 0, dCol: 1 },
    { dRow: 1, dCol: 1 },
  ];
  const match = {
    tab,
    row: { ...row, cell: selectCompendiumCells(tab, row.anchor, cells)! },
    cells,
  };
  const compact = compactMatch(match);
  const proposal = compactProposal({ match, candidates: [match] });
  expect(compact.tab.rows).toEqual([]);
  expect(compact.tab.grid).toBeUndefined();
  expect(proposal.candidates[0].tab).toBe(compact.tab);
  expect(snapshotCompendium(compact, '2026-11-04T00:00:00Z')).toEqual(
    snapshotCompendium(match, '2026-11-04T00:00:00Z'),
  );
  const confirmed = confirmCompendiumSelection(compact, {
    fetchedAt: '2026-11-04T00:00:00Z',
    tabs: [tab],
  });
  expect(confirmed?.snapshot.plain).toBe('One\nTwo');
  expect(confirmed?.cells).toEqual(cells);
  expect(tab.grid).toHaveLength(3);
});
