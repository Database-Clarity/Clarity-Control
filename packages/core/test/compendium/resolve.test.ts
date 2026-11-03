import { describe, expect, it } from 'vitest';
import {
  normaliseCompendiumName,
  resolveCompendiumLink,
  snapshotCompendium,
  compendiumSimilarity,
} from '../../src/compendium/resolve.js';
import type { CompendiumData, CompendiumLink, CompendiumRow } from '../../src/compendium/types.js';
const cell = (text: string, color?: string) => ({
  plain: text,
  runs: [{ text, ...(color ? { color } : {}) }],
});
const row = (
  name: string,
  text = 'Grants increased damage for ten seconds.',
  section?: string,
): CompendiumRow => ({
  name,
  nameNorm: normaliseCompendiumName(name),
  rowIndex: 6,
  cell: cell(text),
  ...(section ? { section } : {}),
});
const link: CompendiumLink = {
  gid: '1',
  rowKey: 'Test',
  snapshot: cell('Grants increased damage for ten seconds.'),
  snapshotAt: '2026-10-01T00:00:00Z',
};
const data = (first: CompendiumRow[] = [], second: CompendiumRow[] = []): CompendiumData => ({
  fetchedAt: '2026-10-27T00:00:00Z',
  tabs: [
    { gid: '1', name: 'Weapon Perks', rows: first },
    { gid: '2', name: 'Other', rows: second },
  ],
});
describe('robust Compendium link resolution', () => {
  it('returns ok after rows reorder and changed on text OR style changes', () => {
    expect(resolveCompendiumLink(link, data([row('Test')])).status).toBe('ok');
    expect(resolveCompendiumLink(link, data([row('Test', 'different')])).status).toBe('changed');
    const styled = { ...row('Test'), cell: cell(link.snapshot.plain, '#ff0000') };
    expect(resolveCompendiumLink(link, data([styled])).status).toBe('changed');
  });
  it('combines duplicate names rather than selecting the closest snapshot', () => {
    const result = resolveCompendiumLink(
      link,
      data([row('Test', 'first', 'A'), { ...row('Test', 'second', 'B'), rowIndex: 7 }]),
    );
    expect(result).toMatchObject({
      status: 'changed',
      parts: ['A', 'B'],
      row: { cell: { plain: 'A\nfirst\n\nB\nsecond' } },
    });
  });
  it('auto-follows unique normalized names across every tab, not row positions', () => {
    const resolved = resolveCompendiumLink(link, data([], [row('Tést! (Enhanced)')]));
    expect(resolved).toMatchObject({ status: 'moved', changed: false, tab: { gid: '2' } });
    if (resolved.status !== 'moved') throw new Error('Expected moved link');
    expect(snapshotCompendium(resolved, '2026-10-27T00:00:00Z')).toMatchObject({
      gid: '2',
      rowKey: 'Tést! (Enhanced)',
      snapshotAt: '2026-10-27T00:00:00Z',
    });
  });
  it('offers top three content-similar candidates without silently relinking renamed rows', () => {
    const result = resolveCompendiumLink(
      link,
      data([row('Renamed'), row('Another'), row('Third'), row('Fourth')]),
    );
    expect(result.status).toBe('candidates');
    if (result.status !== 'candidates') throw new Error('Expected candidates');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.similarity >= 0.6)).toBe(true);
    expect(
      compendiumSimilarity(
        'Grants increased damage for ten seconds.',
        'Grants increased damage for twelve seconds.',
      ),
    ).toBeGreaterThanOrEqual(0.6);
  });
  it('never auto-selects an ambiguous normalized name, and reports missing unrelated data', () => {
    expect(resolveCompendiumLink(link, data([row('Test (Enhanced)')], [row('TÉST')])).status).toBe(
      'candidates',
    );
    expect(
      resolveCompendiumLink(link, data([row('Another', 'nothing similar at all')])).status,
    ).toBe('missing');
    expect(resolveCompendiumLink(link, data()).status).toBe('missing');
  });
});

// Rename fallback must preserve the same safety boundaries as name resolution.
it('follows a unique identical rename across tabs, preserving styled snapshots', () => {
  const result = resolveCompendiumLink(link, data([], [row('Renamed')]));
  expect(result).toMatchObject({ status: 'moved', changed: false, tab: { gid: '2' } });
  if (result.status !== 'moved') throw new Error('Expected moved');
  expect(snapshotCompendium(result)).toMatchObject({ rowKey: 'Renamed', gid: '2' });
  const styled = { ...row('Renamed'), cell: cell(link.snapshot.plain, '#ff0000') };
  expect(resolveCompendiumLink(link, data([styled])).status).toBe('relink-suggested');
  expect(
    resolveCompendiumLink({ ...link, parts: ['Old part'] }, data([row('Renamed')])).status,
  ).toBe('relink-suggested');
});
it('requires both a strict similarity threshold and a clear runner-up margin', () => {
  const similar = row('Renamed', link.snapshot.plain + '!');
  expect(resolveCompendiumLink(link, data([similar])).status).toBe('relink-suggested');
  expect(
    resolveCompendiumLink(
      link,
      data([row('Renamed', 'Grants increased damage for twelve seconds.')]),
    ).status,
  ).toBe('candidates');
  expect(
    resolveCompendiumLink(
      link,
      data([similar, { ...similar, name: 'Rival', nameNorm: 'rival', rowIndex: 7 }]),
    ).status,
  ).toBe('candidates');
  expect(resolveCompendiumLink(link, data([row('Renamed')], [row('Rival')])).status).toBe(
    'candidates',
  );
});
it('compares override cells at renamed arbitrary anchors without configured-cell fallback', () => {
  const cells = [{ dRow: 0, dCol: 1 }];
  const overridden = { ...link, cells };
  const source: CompendiumData = {
    ...data(),
    tabs: [
      {
        gid: '2',
        name: 'Arc',
        rows: [],
        grid: [
          { row: 20, col: 0, cell: cell('Renamed anchor') },
          { row: 20, col: 1, cell: link.snapshot },
        ],
      },
    ],
  };
  expect(resolveCompendiumLink(overridden, source)).toMatchObject({
    status: 'moved',
    cells,
    row: { name: 'Renamed anchor' },
  });
  source.tabs[0].grid![1].cell = cell(link.snapshot.plain + '!');
  expect(resolveCompendiumLink(overridden, source)).toMatchObject({
    status: 'relink-suggested',
    candidate: { cells },
  });
  source.tabs[0].grid = [];
  source.tabs[0].rows = [row('Renamed')];
  expect(resolveCompendiumLink(overridden, source).status).toBe('missing');
});
it('does not relink to ignored OLD tabs', () => {
  const source = data([], [row('Renamed')]);
  source.tabs[1].name = 'Weapon Perks OLD';
  expect(resolveCompendiumLink(link, source).status).toBe('missing');
});
describe('Compendium sheet backgrounds', () => {
  const tinted = { ...cell('Grants increased damage for ten seconds.'), background: '#2e3c4e' };
  it('are display-only: ignored when comparing, kept out of stored links', () => {
    const source: CompendiumRow = { ...row('Test'), cell: tinted };
    const resolved = resolveCompendiumLink(link, data([source]));
    expect(resolved.status).toBe('ok');
    if (!('row' in resolved)) throw new Error('expected a matched row');
    expect(resolved.row.cell.background).toBe('#2e3c4e');
    const stored = snapshotCompendium(resolved);
    expect(stored.snapshot).toEqual(cell('Grants increased damage for ten seconds.'));
    expect('background' in stored.snapshot).toBe(false);
  });
});
