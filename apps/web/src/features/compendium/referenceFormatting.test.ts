import { expect, it } from 'vitest';
import {
  combineCompendiumMatches,
  normaliseCompendiumName,
  normaliseRuns,
  snapshotCompendium,
} from '@clarity/core';
import { currentReferenceLink, referenceCurrent, sampleReference } from './sampleReferences';
import { guidedFixture } from '../../../test/guided-fixture';
import { sourceFingerprint } from './reviewProgress';

it('refreshes only a proven formatter-only multipart reference and preserves its authority/date', () => {
  const f = guidedFixture(),
    entry = f.categories[0].entries[2];
  const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
  const tab = {
    gid: '1186062409',
    name: 'Solar',
    rows: [0, 1].map((i) => {
      const name = `Nova Dive (${i ? 'Empowered' : 'Normal'})`;
      return {
        name,
        nameNorm: normaliseCompendiumName(name),
        rowIndex: 10 + i,
        anchor: { row: 10 + i, col: 1 },
        cell: cell(`Effect ${i}\nBase Cooldown: 90 seconds`),
      };
    }),
    grid: [0, 1].flatMap((i) => [
      { row: 10 + i, col: 3, cell: cell(`Effect ${i}`) },
      { row: 10 + i, col: 13, cell: cell('Base Cooldown: 90 seconds') },
    ]),
  };
  f.source.tabs = [tab];
  f.baseline = `synthetic|${sourceFingerprint(f.source.tabs)}`;
  const combined = combineCompendiumMatches(tab.rows.map((row) => ({ tab, row })))!;
  const reference = sampleReference(
    entry,
    f.categories[0].id,
    f.baseline,
    '',
    'picked',
    combined,
    f.source,
  );
  const parts = ['Old generated label one', 'Old generated label two'];
  const old = {
    ...snapshotCompendium(combined, '2026-11-01T00:00:00Z'),
    parts,
    snapshot: normaliseRuns(
      tab.rows.flatMap((row, i) => [
        ...(i ? [{ text: '\n\n' }] : []),
        { text: `${parts[i]}\n`, bold: true },
        ...row.cell.runs,
      ]),
    ),
  };
  reference.link = old;
  reference.sourceHash = sourceFingerprint([
    old.gid,
    old.rowKey,
    old.section,
    old.cells,
    old.snapshot,
  ]);
  expect(referenceCurrent(reference, entry, f.baseline, f.source)).toBe(true);
  const upgraded = currentReferenceLink(reference, f.source)!;
  expect(upgraded.parts).toEqual(['Normal', 'Empowered']);
  expect(upgraded.snapshot.plain.match(/Base Cooldown:/g)).toHaveLength(1);
  expect(upgraded.snapshotAt).toBe(old.snapshotAt);
  expect(currentReferenceLink(reference, f.source)).toEqual(upgraded);
  const invalid = { ...reference, sourceHash: 'invalid-source-hash' };
  expect(referenceCurrent(invalid, entry, f.baseline, f.source)).toBe(false);
  tab.rows.push({ ...tab.rows[0], rowIndex: 100 });
  expect(referenceCurrent(reference, entry, f.baseline, f.source)).toBe(false);
  tab.rows.pop();
  tab.rows[0].cell = cell('Changed mechanics\nBase Cooldown: 90 seconds');
  tab.grid[0].cell = cell('Changed mechanics');
  expect(referenceCurrent(reference, entry, f.baseline, f.source)).toBe(false);
});
