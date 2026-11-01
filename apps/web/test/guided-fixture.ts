import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../src/stores/data';
import { emptyProgress, sourceFingerprint } from '../src/features/compendium/reviewProgress';
import { reviewQueue } from '../src/features/compendium/reviewQueue';
import { reviewCategories } from '../src/features/compendium/reviewCategories';
import { proposalFor } from '../src/features/compendium/rapidReview';
import { sampleReference } from '../src/features/compendium/sampleReferences';
import type { GuidanceDocument } from '../src/features/compendium/guidanceSchema';

export function guidedFixture() {
  const timestamp = '2026-11-01T00:00:00Z';
  const source: CompendiumData = {
    fetchedAt: timestamp,
    tabs: [
      {
        gid: '1662574278',
        name: 'Weapon Perks',
        rows: Array.from({ length: 6 }, (_, i) => ({
          rowIndex: i + 10,
          name: `Sample ${100 + i}`,
          nameNorm: `sample ${100 + i}`,
          section: 'Traits',
          cell: { plain: `Mechanics ${i}`, runs: [{ text: `Mechanics ${i}` }] },
        })),
      },
    ],
  };
  const editor: EditorData = {
    items: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        100 + i,
        {
          hash: 100 + i,
          name: `Sample ${100 + i}`,
          categoryId: 'weapon-trait',
          icon: '',
          inGameDescription: `Mechanics ${i}`,
        },
      ]),
    ),
    categories: [],
    aliases: {},
    bundle: {
      sourceCommit: 'synthetic',
      generatedAt: timestamp,
      permissions: { users: {} },
      pushed: {},
      tooltips: {},
    },
  };
  const fingerprint = sourceFingerprint(source.tabs);
  const baseline = `synthetic|${fingerprint}`;
  const entries = reviewQueue(editor, source, {}, emptyProgress(), fingerprint);
  const proposals = new Map(
    entries.map((entry) => [entry.hash, proposalFor(entry.base, editor, source)]),
  );
  const categories = reviewCategories(entries, editor, proposals, false);
  const category = categories[0];
  const references = Object.fromEntries(
    [100, 101, 103, 104, 105].map((hash) => {
      const entry = category.entries.find((entry) => entry.hash === hash)!;
      return [
        hash,
        sampleReference(
          entry,
          category.id,
          baseline,
          '',
          hash === 103
            ? 'no-equivalent'
            : hash === 104
              ? 'skipped'
              : hash === 105
                ? undefined
                : 'accepted',
          proposals.get(hash)?.match,
          source,
        ),
      ];
    }),
  );
  const scope = 'synthetic-only';
  const document: GuidanceDocument = {
    version: 1,
    scope,
    baseline,
    categories: {
      [category.id]: {
        id: category.id,
        name: category.name,
        rule: category.rule,
        active: true,
        count: entries.length,
        hashes: entries.map((entry) => entry.hash),
        comment: '',
        references,
      },
    },
  };
  return { document, categories, proposals, source, baseline, scope, editor };
}
