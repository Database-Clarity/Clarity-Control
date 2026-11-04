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
