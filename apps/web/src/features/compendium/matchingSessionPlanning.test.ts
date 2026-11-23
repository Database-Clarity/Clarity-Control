import { expect, it } from 'vitest';
import { resolveCompendiumLink } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { displayMatches } from './displayMatches';
import {
  prepareMatchingPlan,
  matchingPlanSteps,
  finishMatchingPlan,
  completeMatchingSteps,
} from './matchingSessionPlanning';
import type { DisplayInput } from './matchingSession';
import { emptyProgress } from './reviewProgress';
import { proposalFor } from './rapidReview';
import { guidedDecisions, guidedDecisionSteps } from './guidedDecisions';
import { sampleReference } from './sampleReferences';
import { loadManifestFacts } from './manifestFacts';

it.each([
  'confident',
  'saved',
  'proposed',
  'unowned',
  'draft',
  'revoked',
  'selected-confident',
  'selected-saved',
  'selected-with-unowned-duplicate',
] as const)(
  'matches Threadling only when its near-name row has an independent owner (%s)',
  async (ownership) => {
    const f = guidedFixture();
    const threadling = 100,
      grenade = 101;
    f.editor.items = {
      [threadling]: {
        ...f.editor.items[threadling],
        name: 'Threadling',
        categoryId: 'verbs',
        definitionType: 'DestinyTraitDefinition',
        inGameDescription: 'A Strand creature that seeks enemies.',
      },
      ...(ownership !== 'unowned'
        ? {
            [grenade]: {
              ...f.editor.items[grenade],
              name: 'Threadling Grenade',
              categoryId: 'subclass-grenade',
              inGameDescription: 'A grenade that creates Threadlings.',
            },
          }
        : {}),
    };
    const cell = {
      plain: 'A Strand creature that seeks enemies.',
      runs: [{ text: 'A Strand creature that seeks enemies.' }],
    };
    const grenadeCell = {
      plain: 'Creates three Threadlings.',
      runs: [{ text: 'Creates three Threadlings.' }],
    };
    const tab = {
      gid: '1870531554',
      name: 'Strand',
      grid: [
        { row: 8, col: 3, cell },
        { row: 42, col: 3, cell: grenadeCell },
      ],
      rows: [
        {
          name: 'Threadling',
          nameNorm: 'threadling',
          rowIndex: 8,
          section: 'Glossary',
          anchor: { row: 8, col: 1 },
          cell,
        },
        {
          name: 'Threadling Grenade',
          nameNorm: 'threadling grenade',
          rowIndex: 42,
          section: 'Fragments',
          anchor: { row: 42, col: 1 },
          cell: grenadeCell,
        },
      ],
    };
    if (ownership === 'selected-with-unowned-duplicate')
      tab.rows.push({ ...tab.rows[1], anchor: { row: 42, col: 7 } });
    f.source.tabs = [tab];
    const input: DisplayInput = { drafts: {}, progress: emptyProgress(), scope: f.scope };
    const guidance = { ...f.document, categories: {} };
    const initial = prepareMatchingPlan(f.editor, f.source, input, new Map(), guidance);
    const [keyword] = initial.categories.find((c) => c.id === 'catalog:verbs')!.entries;
    const owner = initial.categories.find((c) => c.id === 'catalog:subclass-grenade')?.entries[0];
    const document = {
      ...guidance,
      baseline: initial.baseline,
      categories: Object.fromEntries(
        initial.categories.map((group) => [
          group.id,
          {
            ...Object.values(f.document.categories)[0],
            id: group.id,
            count: group.entries.length,
            hashes: group.entries.map((e) => e.hash),
            references: {},
          },
        ]),
      ),
    };
    const proposal = proposalFor(keyword.base, f.editor, f.source);
    const proposals = new Map([[threadling, proposal]]);
    if (owner) {
      const selected = ownership.startsWith('selected-');
      const match = {
        tab,
        row: tab.rows[1],
        ...(selected ? { cells: [{ dRow: 0, dCol: 2 }], sourceAnchor: tab.rows[1].anchor } : {}),
      };
      const reference = sampleReference(
        owner,
        'catalog:subclass-grenade',
        initial.baseline,
        '',
        'accepted',
        match,
        f.source,
      );
      if (selected)
        expect(resolveCompendiumLink(reference.link!, f.source)).toMatchObject({
          status: 'ok',
          row: { anchor: { row: 42, col: 1 } },
        });
      proposals.set(grenade, { match, link: reference.link, candidates: [] });
      if (
        ownership === 'confident' ||
        ownership === 'revoked' ||
        ownership === 'selected-confident'
      ) {
        document.categories['catalog:subclass-grenade'].references = { [grenade]: reference };
        if (ownership === 'revoked') {
          const category = document.categories['catalog:subclass-grenade'];
          input.local = {
            ...document,
            categories: {
              [category.id]: {
                ...category,
                references: {
                  [grenade]: sampleReference(owner, category.id, initial.baseline, '', 'skipped'),
                },
              },
            },
          };
        }
      } else if (ownership === 'saved' || selected) {
        f.editor.bundle.tooltips[grenade] = { ...owner.base, compendium: reference.link };
      } else if (ownership === 'draft') {
        input.drafts[grenade] = {
          base: owner.base,
          next: { ...owner.base, compendium: reference.link },
        };
      }
    }
    const expected = ['confident', 'saved', 'selected-confident', 'selected-saved'].includes(
      ownership,
    );
    const full = displayMatches(
      f.editor,
      f.source,
      input.drafts,
      input.progress,
      input.local,
      input.scope,
      proposals,
      document,
    );
    expect(full.matches.has(threadling)).toBe(expected);
    expect(full.decisions.find((decision) => decision.hash === threadling)).toMatchObject(
      expected
        ? { ruleId: 'sole-compendium-candidate', confidence: 'high' }
        : { ruleId: 'uncovered-element-tab', confidence: 'medium' },
    );
    const priorityProposals = new Map([[threadling, proposal]]);
    const targeted = prepareMatchingPlan(
      f.editor,
      f.source,
      input,
      priorityProposals,
      document,
      threadling,
    );
    const result = await completeMatchingSteps(
      f.source,
      matchingPlanSteps(targeted, f.source, priorityProposals, threadling),
    );
    expect(result.matches.get(threadling)).toEqual(full.matches.get(threadling));
  },
);

it('returns exactly the full plan for each priority, including local overrides and preserved links', async () => {
  const f = guidedFixture();
  const base = f.categories[0].entries[0].base;
  const local = structuredClone(f.document);
  local.categories[f.categories[0].id].references![100].decision = 'skipped';
  delete local.categories[f.categories[0].id].references![100].link;
  const inputs: DisplayInput[] = [
    { drafts: {}, progress: emptyProgress(), scope: f.scope },
    { drafts: {}, progress: emptyProgress(), scope: f.scope, local },
    {
      drafts: { 100: { base, next: { ...base, compendium: f.proposals.get(100)!.link } } },
      progress: emptyProgress(),
      scope: f.scope,
    },
  ];
  for (const input of inputs) {
    const expected = displayMatches(
      f.editor,
      f.source,
      input.drafts,
      input.progress,
      input.local,
      input.scope,
      f.proposals,
      f.document,
    );
    const full = prepareMatchingPlan(f.editor, f.source, input, f.proposals, f.document);
    expect(await finishMatchingPlan(full, f.source, f.proposals)).toEqual(expected);
    // Proposals for other hashes have not been computed on the priority path.
    const priority = prepareMatchingPlan(f.editor, f.source, input, new Map(), f.document);
    for (const entry of priority.evidence) {
      const proposals = new Map([[entry.hash, proposalFor(entry.base, f.editor, f.source)]]);
      const targeted = prepareMatchingPlan(
        f.editor,
        f.source,
        input,
        new Map(),
        f.document,
        entry.hash,
      );
      const steps = matchingPlanSteps(targeted, f.source, proposals, entry.hash);
      let next = steps.next();
      while (!next.done) next = steps.next();
      expect(next.value.decisions).toEqual(expected.decisions.filter((d) => d.hash === entry.hash));
      expect(next.value.matches.get(entry.hash)).toEqual(expected.matches.get(entry.hash));
    }
  }
});

it('keeps a current no-equivalent reference in another category when prioritizing one entry', () => {
  const f = guidedFixture();
  const targetId = 'catalog:weapon-mod',
    supportId = 'catalog:armor-mod-general';
  for (const item of Object.values(f.editor.items)) item.categoryId = 'weapon-mod';
  f.editor.items[1285109625] = {
    hash: 1285109625,
    name: 'Support',
    icon: '',
    inGameDescription: 'Synthetic owner support',
    categoryId: 'armor-mod-general',
  };
  const original = f.document.categories[f.categories[0].id];
  f.document.categories = {
    [targetId]: { ...original, id: targetId, references: {} },
    [supportId]: { ...original, id: supportId, hashes: [1285109625], count: 1, references: {} },
  };
  const input = { drafts: {}, progress: emptyProgress(), scope: f.scope };
  const initial = prepareMatchingPlan(f.editor, f.source, input, f.proposals, f.document);
  const support = initial.categories.find((c) => c.id === supportId)!.entries[0];
  f.document.categories[supportId].references![1285109625] = sampleReference(
    support,
    supportId,
    initial.baseline,
    '',
    'no-equivalent',
  );
  const facts = loadManifestFacts();
  const plan = (hash?: number) => {
    const prepared = prepareMatchingPlan(f.editor, f.source, input, f.proposals, f.document, hash);
    const target = prepared.categories
      .find((c) => c.id === targetId)!
      .entries.find((e) => e.hash === 100)!;
    target.classification = undefined;
    target.manifestFacts = {
      item: facts.items['1285109625'],
      version: facts.source.manifestVersion,
    };
    const steps = matchingPlanSteps(prepared, f.source, f.proposals, hash);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value.decisions.filter((d) => d.hash === 100);
  };
  expect(plan(100)).toEqual(plan());
  expect(plan(100)[0]).toMatchObject({
    action: 'no-equivalent',
    ruleId: 'manifest-retired-mod',
    references: [1285109625],
  });
});

it('scopes category planning after collecting global owner-reference context', () => {
  const f = guidedFixture();
  const category = f.categories[0];
  const other = { ...category, id: 'catalog:second', name: 'Second', entries: [] };
  const record = f.document.categories[category.id];
  f.document.categories[other.id] = { ...record, id: other.id, hashes: [999], references: {} };
  const categories = [category, other];
  const full = guidedDecisions(f.document, categories, f.proposals, f.source, f.baseline, f.scope);
  for (const id of [category.id, other.id]) {
    const steps = guidedDecisionSteps(
      f.document,
      categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
      undefined,
      undefined,
      id,
    );
    let next = steps.next();
    let decisionsVisited = 0;
    while (!next.done) {
      decisionsVisited++;
      next = steps.next();
    }
    expect(next.value).toEqual(full.filter((group) => group.id === id));
    expect(decisionsVisited).toBe(f.document.categories[id].hashes.length);
  }
});
