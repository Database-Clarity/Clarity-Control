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
