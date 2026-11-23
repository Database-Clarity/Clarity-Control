import {
  normaliseCompendiumName,
  resolveCompendiumLink,
  withCompendiumMatchingIndex,
  type CompendiumData,
  type CompendiumMatch,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { DisplayInput } from './matchingSession';
import type { ReviewSample } from './reviewCategories';
import { proposalFor, type ReviewProposal } from './rapidReview';
import approved from './approved-guidance.v1.json';
import { guidanceSchema } from './guidanceSchema';
import {
  guidedDecisionSteps,
  type GuidedDecision,
  type OwnsCompendiumRow,
} from './guidedDecisions';
import { rebaselineGuidance } from './rebaselineGuidance';
import { reviewCategories } from './reviewCategories';
import { applyReviewProgress, reviewEvidence } from './reviewQueue';
import { matchingSessionFingerprint } from './matchingSessionFingerprint';
import { classifyScope } from './reviewScope';

/** Retain every category/reference: a single-hash plan still needs global exclusions. */
export function prepareMatchingPlan(
  editor: EditorData,
  source: CompendiumData,
  input: DisplayInput,
  proposals: Map<number, ReviewProposal>,
  approvedInput: unknown = approved,
  onlyHash?: number,
  fingerprint = matchingSessionFingerprint(source.tabs),
) {
  const baseline = `${editor.bundle.sourceCommit}|${fingerprint}`;
  const approvedDocument = guidanceSchema.parse(approvedInput);
  const relevant =
    onlyHash === undefined
      ? undefined
      : new Set(
          [approvedDocument, input.local].flatMap((document) =>
            Object.values(document?.categories ?? {})
              .filter((record) => record.hashes.includes(onlyHash))
              .map((record) => record.id),
          ),
        );
  const referencesFor = (
    id: string,
    references: NonNullable<(typeof approvedDocument.categories)[string]['references']>,
  ) =>
    !relevant || relevant.has(id)
      ? references
      : Object.fromEntries(
          Object.entries(references).filter(
            ([, reference]) => reference.decision === 'no-equivalent',
          ),
        );
  const shipped = relevant
    ? {
        ...approvedDocument,
        categories: Object.fromEntries(
          Object.entries(approvedDocument.categories).map(([id, record]) => [
            id,
            {
              ...record,
              references: referencesFor(id, record.references ?? {}),
            },
          ]),
        ),
      }
    : approvedDocument;
  // Every owner reference, including no-equivalent support in other categories,
  // participates. Unrelated entries only affect review metadata, never this decision.
  const needed =
    onlyHash === undefined
      ? undefined
      : new Set([
          onlyHash,
          ...[shipped, input.local].flatMap((document) =>
            Object.entries(document?.categories ?? {}).flatMap(([id, record]) =>
              Object.values(referencesFor(id, record.references ?? {})).map(
                (reference) => reference.hash,
              ),
            ),
          ),
        ]);
  // Review evidence reads only the addressed item's catalog row and tooltip.
  // Keep the complete editor for manifest grouping/classification below.
  const evidenceEditor = needed
    ? {
        ...editor,
        items: Object.fromEntries(
          [...needed].flatMap((hash) => (editor.items[hash] ? [[hash, editor.items[hash]]] : [])),
        ),
        bundle: {
          ...editor.bundle,
          tooltips: Object.fromEntries(
            [...needed].flatMap((hash) =>
              editor.bundle.tooltips[hash] ? [[hash, editor.bundle.tooltips[hash]]] : [],
            ),
          ),
        },
      }
    : editor;
  const evidence = reviewEvidence(evidenceEditor, source, input.drafts, fingerprint);
  const categories = reviewCategories(
    applyReviewProgress(evidence, input.progress),
    editor,
    proposals,
    false,
    false,
    source,
  );
  const document = rebaselineGuidance(shipped, categories, source, baseline, input.scope).document;
  const local = input.local;
  if (local && local.scope !== input.scope)
    throw new Error('Stored guidance belongs to another dataset.');
  const overrides = local && {
    ...local,
    categories: Object.fromEntries(
      Object.entries(local.categories)
        .filter(([, record]) => record.comment || Object.keys(record.references ?? {}).length)
        .map(([id, record]) => [
          id,
          {
            ...record,
            references: referencesFor(id, {
              ...document.categories[id]?.references,
              ...record.references,
            }),
          },
        ]),
    ),
  };
  return {
    fingerprint,
    baseline,
    evidence,
    categories,
    document,
    overrides,
    scope: input.scope,
    editor,
    input,
    approvedInput,
  };
}

type MatchingPlan = ReturnType<typeof prepareMatchingPlan>;

function* decisionSteps(
  plan: MatchingPlan,
  source: CompendiumData,
  proposals: Map<number, ReviewProposal>,
  onlyHash?: number,
  ownsRow?: OwnsCompendiumRow,
) {
  const { categories, document, overrides, baseline, scope } = plan;
  const decisionsByHash = new Map<number, GuidedDecision>();
  for (const guidance of [document, overrides]) {
    if (!guidance) continue;
    const groups = yield* guidedDecisionSteps(
      guidance,
      categories,
      proposals,
      source,
      baseline,
      scope,
      onlyHash,
      plan.fingerprint,
      undefined,
      ownsRow,
    );
    for (const group of groups)
      for (const decision of group.entries) decisionsByHash.set(decision.hash, decision);
  }
  return decisionsByHash;
}

function competitorOwnership(
  plan: MatchingPlan,
  source: CompendiumData,
  proposals: Map<number, ReviewProposal>,
  priority: boolean,
): OwnsCompendiumRow {
  const { editor, input, approvedInput } = plan;
  let itemsByName: Map<string, number[]> | undefined;
  const ownedMatches = new Map<number, CompendiumMatch | undefined>();
  const independentMatch = (hash: number) => {
    const ownerPlan = priority
      ? prepareMatchingPlan(editor, source, input, proposals, approvedInput, hash, plan.fingerprint)
      : plan;
    const owner = ownerPlan.evidence.find((entry) => entry.hash === hash);
    if (!owner) return;
    if (owner.base.compendium) {
      if (owner.changed) return;
      const saved = resolveCompendiumLink(owner.base.compendium, source);
      if ('row' in saved) return saved;
      return;
    }
    const local = input.progress.decisions[hash];
    if (local && local.fingerprint !== owner.evidence) return;
    const ownerProposals = proposals.has(hash)
      ? proposals
      : new Map([[hash, proposalFor(owner.base, editor, source)]]);
    // No ownership callback here. Even a sole match that didn't need to consult
    // another owner cannot establish ownership for this rule.
    const steps = decisionSteps(ownerPlan, source, ownerProposals, hash);
    let next = steps.next();
    while (!next.done) next = steps.next();
    const decision = next.value.get(hash);
    if (
      decision?.action === 'link' &&
      decision.confidence === 'high' &&
      decision.ruleId !== 'sole-compendium-candidate' &&
      decision.link
    ) {
      const resolved = resolveCompendiumLink(decision.link, source);
      if (resolved.status === 'ok') return resolved;
    }
  };
  return (challenger, match) => {
    if (!itemsByName) {
      itemsByName = new Map();
      for (const item of Object.values(editor.items)) {
        const name = normaliseCompendiumName(item.name);
        const hashes = itemsByName.get(name);
        if (hashes) hashes.push(item.hash);
        else itemsByName.set(name, [item.hash]);
      }
    }
    return (itemsByName.get(normaliseCompendiumName(match.row.name)) ?? []).some((hash) => {
      if (hash === challenger) return false;
      if (!ownedMatches.has(hash)) ownedMatches.set(hash, independentMatch(hash));
      const resolved = ownedMatches.get(hash);
      return (
        !!resolved &&
        resolved.tab.gid === match.tab.gid &&
        (resolved.row === match.row || !!resolved.componentRows?.includes(match.row))
      );
    });
  };
}

export function* matchingPlanSteps(
  plan: MatchingPlan,
  source: CompendiumData,
  proposals: Map<number, ReviewProposal>,
  onlyHash?: number,
) {
  const { categories } = plan;
  const ownership = competitorOwnership(plan, source, proposals, onlyHash !== undefined);
  const decisions = [
    ...(yield* decisionSteps(plan, source, proposals, onlyHash, ownership)).values(),
  ];
  const matches = new Map(
    decisions.flatMap((decision) => {
      if (
        decision.action !== 'link' ||
        !decision.link ||
        !['high', 'out-of-scope'].includes(decision.confidence)
      )
        return [];
      const resolved = resolveCompendiumLink(decision.link, source);
      return resolved.status === 'ok' && 'row' in resolved
        ? [[decision.hash, resolved] as const]
        : [];
    }),
  );
  return {
    matches,
    decisions,
    fingerprint: plan.fingerprint,
    evidence: plan.evidence,
    categories,
    scopeHashes: categories.flatMap((category) =>
      category.entries
        .filter((entry) => !classifyScope(entry, category.id))
        .map((entry) => entry.hash),
    ),
  };
}

// MessageChannel yields do not incur the nested-timer clamp on every worker slice.
export function matchingYield() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function finishMatchingPlan(
  plan: ReturnType<typeof prepareMatchingPlan>,
  source: CompendiumData,
  proposals: Map<number, ReviewProposal>,
) {
  return completeMatchingSteps(source, matchingPlanSteps(plan, source, proposals));
}

export async function completeMatchingSteps<T>(source: CompendiumData, steps: Generator<void, T>) {
  for (;;) {
    const next = withCompendiumMatchingIndex(source, () => {
      const end = performance.now() + 8;
      let next = steps.next();
      while (!next.done && performance.now() < end) next = steps.next();
      return next;
    });
    if (next.done) return next.value;
    await matchingYield();
  }
}

/** A selected review entry is authoritative without claiming catalog readiness. */
export interface PriorityReview {
  hash: number;
  fingerprint: string;
  baseline: string;
  entry?: ReviewSample;
  proposal?: ReviewProposal;
  decision?: GuidedDecision;
  matches: ReturnType<typeof import('./displayMatches').displayMatches>['matches'];
}
