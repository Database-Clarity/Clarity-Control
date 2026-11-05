import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { displayMatches } from './displayMatches';
import {
  prepareMatchingPlan,
  matchingPlanSteps,
  finishMatchingPlan,
} from './matchingSessionPlanning';
import type { DisplayInput } from './matchingSession';
import { emptyProgress } from './reviewProgress';
import { proposalFor } from './rapidReview';
import { guidedDecisions, guidedDecisionSteps } from './guidedDecisions';
import { sampleReference } from './sampleReferences';
import { loadManifestFacts } from './manifestFacts';

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
