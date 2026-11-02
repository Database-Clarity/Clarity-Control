import { expect, it } from 'vitest';
import { compendiumDataSchema } from '@clarity/core';
import frozen from './fixtures/frozen-matcher.json';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions } from './guidedDecisions';
import { proposalFor } from './rapidReview';
import type { EditorData } from '../../stores/data';

it('links all 69 frozen armor disagreements to their audited core destinations', () => {
  expect(frozen.entries.filter((e) => e.expected)).toHaveLength(69);
  for (const item of frozen.entries) {
    const f = guidedFixture(),
      category = f.categories[0];
    const record = f.document.categories[category.id];
    category.id = record.id = `catalog:${item.category}`;
    record.references = {};
    const entry = {
      ...category.entries[2],
      ...item,
      base: {
        ...category.entries[2].base,
        ...frozen.tooltips[item.hash as unknown as keyof typeof frozen.tooltips],
        hash: item.hash,
      },
      exoticParentNames: [
        (frozen.items as unknown as EditorData['items'])[item.hash]?.itemName,
      ].filter(Boolean) as string[],
    };
    record.hashes = [item.hash];
    category.entries = [entry];
    f.source = compendiumDataSchema.parse(frozen.source);
    f.editor.items = frozen.items as unknown as EditorData['items'];
    f.editor.aliases = frozen.aliases;
    f.editor.bundle.tooltips = frozen.tooltips as unknown as EditorData['bundle']['tooltips'];
    const proposals = new Map([[item.hash, proposalFor(entry.base, f.editor, f.source)]]);
    const decision = guidedDecisions(
      f.document,
      [category],
      proposals,
      f.source,
      f.baseline,
      f.scope,
    )[0].entries[0];
    if (item.expected) expect(decision.link, item.name).toMatchObject(item.expected);
    if (item.negative) expect(decision.link, item.name).toBeUndefined();
    if (item.name === 'Multi-Threaded Snare Refit' || item.name === 'Prometheus Catalyst') expect(decision.ruleId).toBe('exotic-catalog-parent');
  }
});
