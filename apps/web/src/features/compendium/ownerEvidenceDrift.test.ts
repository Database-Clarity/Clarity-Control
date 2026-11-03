import { expect, it } from 'vitest';
import { compendiumDataSchema } from '@clarity/core';
import fixture from './fixtures/owner-reviewed.json';
import records from './owner-reviewed.json';
import { guidedFixture } from '../../../test/guided-fixture';
import { reviewedOwnerDecision } from './ownerReviewed';
import { proposalFor } from './rapidReview';
import type { EditorData } from '../../stores/data';

it('replays every owner-reviewed styled body across display-only changes and rejects text changes', () => {
  for (const record of Object.values(records.verified)) {
    const f = guidedFixture();
    f.editor.items = fixture.items as unknown as EditorData['items'];
    f.editor.bundle.tooltips = fixture.tooltips as unknown as EditorData['bundle']['tooltips'];
    const source = compendiumDataSchema.parse(fixture.source);
    const item = f.editor.items[record.hash];
    const base = f.editor.bundle.tooltips[record.hash];
    const entry = {
      ...f.categories[0].entries[0],
      hash: record.hash,
      name: item.name,
      category: item.categoryId,
      base,
      next: base,
    };
    for (const tab of source.tabs)
      for (const cell of [...tab.rows, ...(tab.grid ?? [])]) {
        cell.cell.background = '#123456';
        for (const run of cell.cell.runs) run.textAlign = 'center';
      }
    const decide = () => reviewedOwnerDecision(entry, proposalFor(base, f.editor, source), source);
    expect(decide()?.action, record.name).toBe('link');
    if (record.mode === 'armor') {
      const tab = source.tabs.find((t) => t.gid === record.gid)!;
      const matches = tab.rows.filter((r) => r.name === record.rows[0].name);
      expect(matches).toHaveLength(2);
      // Parser keeps the first anchor inside the approved spanning description.
      tab.rows = tab.rows.filter((r) => r !== matches[1]);
      expect(decide()?.action, record.name + ' duplicate removed').toBe('link');
    }
    const tab = source.tabs.find((t) => t.gid === record.gid)!;
    const row = tab.rows.find((r) => r.name === record.rows[0].name)!;
    row.cell = { plain: 'Changed text', runs: [{ text: 'Changed text' }] };
    expect(decide()?.action, record.name + ' text changed').toBe('owner');
    expect(
      reviewedOwnerDecision(
        { ...entry, name: 'Wrong identity' },
        proposalFor(base, f.editor, source),
        source,
      )?.action,
    ).toBe('owner');
  }
});
