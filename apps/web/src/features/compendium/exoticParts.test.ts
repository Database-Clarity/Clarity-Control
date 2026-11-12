import { expect, it } from 'vitest';
import { compendiumDataSchema } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import frozen from './fixtures/frozen-matcher.json';
import census from './fixtures/stat-only-census.json';
import exceptions from './owner-exceptions.json';
import { guidedDecisions } from './guidedDecisions';
import { reviewQueue } from './reviewQueue';
import { reviewCategories } from './reviewCategories';
import { proposalFor } from './rapidReview';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import type { EditorData } from '../../stores/data';

function partsFixture() {
  const f = guidedFixture();
  f.editor.items = frozen.items as unknown as EditorData['items'];
  f.editor.aliases = frozen.aliases;
  f.editor.bundle.tooltips = Object.fromEntries(
    Object.keys(exceptions.exoticStats).map((hash) => [
      hash,
      {
        hash: Number(hash),
        associated: [],
        text: census.savedText.includes(Number(hash))
          ? {
              en: {
                text: 'Authored part text',
                updatedAt: f.source.fetchedAt,
                updatedBy: 'fixture',
              },
            }
          : {},
      },
    ]),
  );
  f.source = compendiumDataSchema.parse(frozen.source);
  const fingerprint = sourceFingerprint(f.source.tabs);
  f.baseline = `${f.editor.bundle.sourceCommit}|${fingerprint}`;
  const entries = reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint);
  f.proposals = new Map(entries.map((e) => [e.hash, proposalFor(e.base, f.editor, f.source)]));
  f.categories = reviewCategories(entries, f.editor, f.proposals, false, false, f.source);
  f.document.baseline = f.baseline;
  f.document.categories = Object.fromEntries(
    f.categories.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        rule: c.rule,
        active: true,
        count: c.entries.length,
        hashes: c.entries.map((e) => e.hash),
        comment: '',
        references: {},
      },
    ]),
  );
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope).flatMap(
      (g) => g.entries,
    );
  return { ...f, decide };
}

it('withholds all seventeen historic weapon-row links through the real category pipeline', () => {
  const f = partsFixture();
  const decisions = f.decide();
  for (const [hash, name] of Object.entries(exceptions.exoticStats)) {
    const decision = decisions.find((e) => e.hash === Number(hash))!;
    expect(decision, name).toMatchObject({
      action: census.savedText.includes(Number(hash)) ? 'owner' : 'out-of-scope',
      confidence: census.savedText.includes(Number(hash)) ? 'unresolved' : 'out-of-scope',
    });
    expect(decision.link, name).toBeUndefined();
    expect(decision.reason, name).toContain('weapon row is not its text');
  }
});

it.each([3492498209, 2931483505])(
  'never promotes barrel/ornament %s on the same exotic, even with a selected candidate',
  (hash) => {
    const f = partsFixture();
    const entry = f.categories.flatMap((c) => c.entries).find((e) => e.hash === hash)!;
    entry.exoticParentNames = ['Revision Zero'];
    const tab = f.source.tabs.find((t) => t.name === 'Exotic Weapons')!;
    const row = tab.rows.find((r) => r.name.startsWith('Revision Zero'))!;
    f.proposals.set(hash, { match: { tab, row }, candidates: [{ tab, row }] });
    expect(f.decide().find((e) => e.hash === hash)?.link).toBeUndefined();
    // Saved/draft links, and human decisions, always take precedence over the guard.
    const link = {
      gid: tab.gid,
      rowKey: row.name,
      rowIndex: row.rowIndex,
      snapshot: row.cell,
      snapshotAt: f.source.fetchedAt,
    };
    for (const target of [entry.base, entry.next]) {
      target.compendium = link;
      expect(f.decide().find((e) => e.hash === hash)?.action).toBe('preserve');
      expect(target.compendium).toBe(link);
      delete target.compendium;
    }
    entry.status = 'skipped';
    expect(f.decide().find((e) => e.hash === hash)?.action).toBe('preserve');
  },
);
