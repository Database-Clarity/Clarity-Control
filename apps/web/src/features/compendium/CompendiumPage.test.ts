import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { compendiumLists } from './CompendiumPage';

it('retains tab projections, while saved links and source revisions invalidate them', () => {
  const { editor, source } = guidedFixture();
  const row = source.tabs[0].rows[0];
  const oldCell = { plain: 'Older source', runs: [{ text: 'Older source' }] };
  editor.bundle.tooltips[100] = {
    hash: 100,
    text: {},
    associated: [],
    compendium: {
      gid: source.tabs[0].gid,
      rowKey: row.name,
      snapshot: oldCell,
      snapshotAt: source.fetchedAt,
    },
  };
  const first = compendiumLists(editor, source);
  expect(first.changes.map(({ tooltip }) => tooltip.hash)).toEqual([100]);
  expect(first.missing.map(({ hash }) => hash)).toEqual([101, 102, 103, 104, 105]);
  expect(compendiumLists(editor, source).changes).toBe(first.changes);
  expect(compendiumLists(editor).missing).toBe(first.missing);
  const revisedSource = {
    ...source,
    tabs: [{ ...source.tabs[0], rows: [{ ...row, cell: oldCell }] }],
  };
  expect(compendiumLists(editor, revisedSource).changes).toEqual([]);
  expect(compendiumLists(editor, source).changes).toBe(first.changes);
  const saved = {
    ...editor,
    bundle: { ...editor.bundle, tooltips: {} },
  };
  const updated = compendiumLists(saved, source);
  expect(updated.changes).toEqual([]);
  expect(updated.missing.map(({ hash }) => hash)).toEqual([100, 101, 102, 103, 104, 105]);
});
