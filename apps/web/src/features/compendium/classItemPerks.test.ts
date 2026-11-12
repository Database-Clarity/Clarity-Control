import { expect, it } from 'vitest';
import { compendiumDataSchema, type CompendiumData } from '@clarity/core';
import approved from './approved-guidance.v1.json';
import { inferredClassItemPerkDecision } from './safeSourceRules';
import type { ReviewSample } from './reviewCategories';

// Two perks share each sheet row in the Exotic Class tab (columns A and D), as in the live sheet.
function source(names: string[][], gid = '20898389'): CompendiumData {
  return compendiumDataSchema.parse({
    fetchedAt: '2026-11-12T00:00:00.000Z',
    tabs: [
      {
        gid,
        name: gid === '20898389' ? 'Exotic Class' : 'Exotic Armors',
        rows: names.flatMap((pair, index) =>
          pair.map((name, column) => ({
            name,
            nameNorm: name.toLowerCase(),
            section: 'Warlock-exclusive Perks',
            rowIndex: 20 + index,
            anchor: { row: 20 + index, col: column * 3 },
            cell: { plain: `${name} mechanics`, runs: [{ text: `${name} mechanics` }] },
          })),
        ),
      },
    ],
  });
}
const entry = (name: string, category = 'armor-trait-exotic-class-item') =>
  ({ hash: 1, name, category }) as unknown as ReviewSample;
const sheet = source([
  ['Spirit of the Swarm', 'Spirit of Galanor'],
  ['Spirit of the Inmost Light', 'Spirit of the Claw'],
]);

it('links an exact unique perk name in the Exotic Class tab as high confidence', () => {
  for (const name of ['Spirit of the Swarm', 'Spirit of Galanor']) {
    const decision = inferredClassItemPerkDecision(entry(name), sheet)!;
    expect(decision).toMatchObject({
      action: 'link',
      confidence: 'high',
      ruleId: 'exotic-class-item-perk',
    });
    expect(decision.link).toMatchObject({ gid: '20898389', rowKey: name });
    expect(decision.link!.snapshot.plain).toBe(`${name} mechanics`);
  }
});

it('links both live "Spirit of the" article cases only while the stem is unique', () => {
  const live = source([
    ['Spirit of the Inmost Light', 'Spirit of the Synthoceps'],
    ['Spirit of the Swarm', 'Spirit of Galanor'],
  ]);
  for (const name of ['Spirit of Inmost Light', 'Spirit of Synthoceps']) {
    const decision = inferredClassItemPerkDecision(entry(name), live, ['Spirit of the Swarm'])!;
    expect(decision).toMatchObject({
      action: 'link',
      confidence: 'high',
      ruleId: 'exotic-class-item-article',
    });
    expect(decision.link?.rowKey).toBe(name.replace('Spirit of ', 'Spirit of the '));
  }
  // Another class item perk sharing the stem keeps a proposal, never an automatic match.
  expect(
    inferredClassItemPerkDecision(entry('Spirit of Inmost Light'), live, [
      'Spirit of the Inmost Light ',
    ]),
  ).toMatchObject({ action: 'link', confidence: 'medium', ruleId: 'exotic-class-item-article' });
});

it('rejects duplicate, missing, other-tab, and other-category names', () => {
  const duplicate = source([['Spirit of the Swarm', 'Spirit of the Swarm']]);
  expect(inferredClassItemPerkDecision(entry('Spirit of the Swarm'), duplicate)).toMatchObject({
    action: 'owner',
    confidence: 'unresolved',
  });
  // An exact row wins over the article variant; two rows sharing the stem stay unresolved.
  const stems = source([['Spirit of Renewal', 'Spirit of the Renewal']]);
  expect(inferredClassItemPerkDecision(entry('Spirit of Renewal'), stems)?.ruleId).toBe(
    'exotic-class-item-perk',
  );
  const twoStems = source([
    ['Spirit of the Renewal', 'Spirit of the Coyote'],
    ['Spirit of the Renewal', 'Spirit of Vesper'],
  ]);
  expect(inferredClassItemPerkDecision(entry('Spirit of Renewal'), twoStems)).toMatchObject({
    action: 'owner',
    ruleId: 'exotic-class-item-perk',
  });
  expect(inferredClassItemPerkDecision(entry('Spirit of the Bear'), sheet)?.action).toBe('owner');
  const otherTab = source([['Spirit of the Swarm', 'Spirit of Galanor']], '1500097863');
  expect(inferredClassItemPerkDecision(entry('Spirit of the Swarm'), otherTab)?.action).toBe(
    'owner',
  );
  expect(
    inferredClassItemPerkDecision(entry('Spirit of the Swarm', 'armor-trait-exotic'), sheet),
  ).toBeUndefined();
});

it('ships active membership for all 36 class item perks', () => {
  const record = (approved.categories as Record<string, { active: boolean; hashes: number[] }>)[
    'catalog:armor-trait-exotic-class-item'
  ];
  expect(record.active).toBe(true);
  expect(new Set(record.hashes).size).toBe(36);
});
