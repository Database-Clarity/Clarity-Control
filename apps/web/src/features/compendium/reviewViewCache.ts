import { resolveCompendiumLink, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { displayMatches } from './displayMatches';
import { applyReviewProgress, type reviewEvidence } from './reviewQueue';
import type { ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';
import { deriveQueueRows, type QueueRow } from './queueRows';
import { sortRows, type CategoryInfo } from './queueView';

type Prepared = ReturnType<typeof displayMatches>;
type Evidence = ReturnType<typeof reviewEvidence>;
const projections = new WeakMap<
  Prepared,
  WeakMap<EditorData, { source: CompendiumData; drafts: WeakMap<Drafts, Evidence> }>
>();
const reviewed = new WeakMap<
  Evidence,
  { decisions: string; entries: ReturnType<typeof applyReviewProgress> }
>();
const proposals = new WeakMap<
  Prepared,
  WeakMap<Map<number, ReviewProposal>, Map<number, ReviewProposal>>
>();

// Data and draft objects are immutable. Retain the projection across workspace mounts,
// while always overlaying the actual current draft text rather than the worker's metadata copy.
export function preparedEvidence(
  prepared: Prepared,
  drafts: Drafts,
  editor: EditorData,
  source: CompendiumData,
): Evidence {
  let byEditor = projections.get(prepared);
  if (!byEditor) projections.set(prepared, (byEditor = new WeakMap()));
  let projection = byEditor.get(editor);
  if (!projection || projection.source !== source) {
    projection = { source, drafts: new WeakMap() };
    byEditor.set(editor, projection);
  }
  const byDrafts = projection.drafts;
  const previous = byDrafts.get(drafts);
  if (previous) return previous;
  const evidence = prepared.evidence.map((entry) => {
    // Worker clones are evidence, not the editor's draft baseline. Existing acceptance
    // guards compare original tooltip identities and must retain current translations.
    const base = editor.bundle.tooltips[entry.hash] ?? entry.base;
    const next = drafts[entry.hash]?.next ?? base;
    const sameLink =
      next.compendium === entry.next.compendium ||
      JSON.stringify(next.compendium) === JSON.stringify(entry.next.compendium);
    if (sameLink)
      return base === entry.base && next === entry.next ? entry : { ...entry, base, next };
    // A local link change affects just this row. Keep the factual queue responsive
    // while the worker revalidates automatic matches; never reuse its old link status.
    const resolved = next.compendium && resolveCompendiumLink(next.compendium, source);
    return {
      ...entry,
      base,
      next,
      valid: !!resolved && ['ok', 'changed', 'moved'].includes(resolved.status),
      changed: JSON.stringify(base.compendium) !== JSON.stringify(next.compendium),
    };
  });
  byDrafts.set(drafts, evidence);
  return evidence;
}

export function reviewedEntries(evidence: Evidence, progress: ReviewProgress) {
  // Selection and filters do not affect entry evidence or local decisions.
  const decisions = JSON.stringify(progress.decisions);
  const previous = reviewed.get(evidence);
  if (previous?.decisions === decisions) return previous.entries;
  const entries = applyReviewProgress(evidence, progress);
  reviewed.set(evidence, { decisions, entries });
  return entries;
}

export function preparedProposals(prepared: Prepared, core: Map<number, ReviewProposal>) {
  let byCore = proposals.get(prepared);
  if (!byCore) proposals.set(prepared, (byCore = new WeakMap()));
  const previous = byCore.get(core);
  if (previous) return previous;
  const shown = new Map(core);
  const decisions = new Map(prepared.decisions.map((decision) => [decision.hash, decision]));
  for (const [hash, match] of prepared.matches) {
    shown.set(hash, {
      match,
      link: decisions.get(hash)?.link,
      candidates: shown.get(hash)?.candidates ?? [],
    });
  }
  byCore.set(core, shown);
  return shown;
}

/** Prepare the same proposal projection without occupying an editor input task. */
export function warmPreparedProposals(prepared: Prepared, core: Map<number, ReviewProposal>) {
  let byCore = proposals.get(prepared);
  if (!byCore) proposals.set(prepared, (byCore = new WeakMap()));
  if (byCore.has(core)) return () => {};

  // Keep partial results private. Foreground callers can still build the complete
  // projection synchronously, and cancelling never exposes incomplete matches.
  function* build() {
    const shown = new Map<number, ReviewProposal>();
    for (const [hash, proposal] of core) {
      shown.set(hash, proposal);
      yield;
    }
    const decisions = new Map<number, Prepared['decisions'][number]>();
    for (const decision of prepared.decisions) {
      decisions.set(decision.hash, decision);
      yield;
    }
    for (const [hash, match] of prepared.matches) {
      shown.set(hash, {
        match,
        link: decisions.get(hash)?.link,
        candidates: core.get(hash)?.candidates ?? [],
      });
      yield;
    }
    return shown;
  }
  const work = build();
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inputPending = () =>
    (
      globalThis.navigator as
        | (Navigator & {
            scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
          })
        | undefined
    )?.scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  function schedule() {
    // No deadline timeout: speculative work must wait when there is no idle time.
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run);
    else timer = setTimeout(() => run(), 16);
  }
  function run(deadline?: IdleDeadline) {
    if (cancelled || byCore!.has(core)) return;
    const started = performance.now();
    for (let count = 0; count < 64; count++) {
      if (
        inputPending() ||
        performance.now() - started >= 1 ||
        (deadline && deadline.timeRemaining() <= 1)
      )
        break;
      const next = work.next();
      if (next.done) {
        byCore!.set(core, next.value);
        return;
      }
    }
    schedule();
  }
  schedule();
  return () => {
    cancelled = true;
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

const rowCache = new WeakMap<
  ReturnType<typeof applyReviewProgress>,
  {
    prepared: Prepared | undefined;
    proposals: Map<number, ReviewProposal>;
    restored: ReadonlySet<number>;
    categories: ReadonlyMap<string, CategoryInfo>;
    rows: QueueRow[];
  }
>();
const decisionIndex = new WeakMap<Prepared, Map<number, Prepared['decisions'][number]>>();

/** Decisions by hash, built once per prepared display. */
export function preparedDecisions(prepared: Prepared | undefined) {
  if (!prepared) return new Map<number, Prepared['decisions'][number]>();
  let index = decisionIndex.get(prepared);
  if (!index) decisionIndex.set(prepared, (index = new Map(prepared.decisions.map((d) => [d.hash, d]))));
  return index;
}

/**
 * Queue rows for the Compendium tab, built once per (entries, display, proposals, scope). Selection,
 * filters, and search narrow this array; they never rebuild it.
 */
export function preparedQueueRows(
  entries: ReturnType<typeof applyReviewProgress>,
  prepared: Prepared | undefined,
  proposals: Map<number, ReviewProposal>,
  restored: ReadonlySet<number>,
  categories: ReadonlyMap<string, CategoryInfo>,
): QueueRow[] {
  const previous = rowCache.get(entries);
  if (
    previous &&
    previous.prepared === prepared &&
    previous.proposals === proposals &&
    previous.restored === restored &&
    previous.categories === categories
  )
    return previous.rows;
  const rows = sortRows(
    deriveQueueRows({ entries, decisions: preparedDecisions(prepared), proposals, restored }),
    categories,
  );
  rowCache.set(entries, { prepared, proposals, restored, categories, rows });
  return rows;
}
