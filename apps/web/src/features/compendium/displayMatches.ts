import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { GuidanceDocument } from './guidanceSchema';
import { matchingPlanSteps, prepareMatchingPlan } from './matchingSessionPlanning';
import { sourceFingerprint, type ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';

export function displayMatches(
  editor: EditorData,
  source: CompendiumData,
  drafts: Drafts,
  progress: ReviewProgress,
  local: GuidanceDocument | undefined,
  scope: string,
  proposals: Map<number, ReviewProposal>,
  approvedInput?: unknown,
) {
  const plan = prepareMatchingPlan(
    editor,
    source,
    { drafts, progress, local, scope },
    proposals,
    approvedInput,
    undefined,
    sourceFingerprint(source.tabs),
  );
  const steps = matchingPlanSteps(plan, source, proposals);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
