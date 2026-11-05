import { resolveCompendiumLink, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { displayMatches } from './displayMatches';
import { applyReviewProgress, type reviewEvidence } from './reviewQueue';
import type { ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';
import { categoryId } from './reviewCategories';
import { classifyScope } from './reviewScope';
import type { SidebarCategory } from '../navigation/sidebarQueue';
import { reviewPreparationInput } from './reviewPreparation';

type Prepared = ReturnType<typeof displayMatches>;
type Evidence = ReturnType<typeof reviewEvidence>;
type Entries = ReturnType<typeof applyReviewProgress>;
type EntryProjection = ReturnType<typeof buildEntryProjection>;
const scopeProjections = new WeakMap<
  Prepared['categories'],
  WeakMap<Entries, { scopeHashes: Prepared['scopeHashes'] | undefined; hashes: Set<number> }>
>();
const entryProjections = new WeakMap<
  Entries,
  WeakMap<ReadonlySet<number>, WeakMap<Map<number, ReviewProposal>, EntryProjection>>
>();
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
const emptyRestored: ReadonlySet<number> = new Set();
const sidebarProjections = new WeakMap<
  Prepared['categories'],
  WeakMap<EntryProjection, { base: SidebarCategory[]; selected?: number; rows: SidebarCategory[] }>
>();
const categoryProjections = new WeakMap<
  Prepared,
  WeakMap<
    ReturnType<typeof applyReviewProgress>,
    WeakMap<ReadonlySet<number>, Prepared['categories']>
  >
>();

export function reviewScopeHashes(
  categories: Prepared['categories'],
  entries: Entries,
  scopeHashes?: Prepared['scopeHashes'],
) {
  let byEntries = scopeProjections.get(categories);
  if (!byEntries) scopeProjections.set(categories, (byEntries = new WeakMap()));
  const previous = byEntries.get(entries);
  if (previous && previous.scopeHashes === scopeHashes) return previous.hashes;
  const hashes = scopeHashes
    ? new Set(scopeHashes)
    : new Set(
        categories.flatMap((category) =>
          category.entries
            .filter((entry) => !classifyScope(entry, category.id))
            .map((entry) => entry.hash),
        ),
      );
  if (scopeHashes) for (const entry of entries) if (entry.status !== 'open') hashes.add(entry.hash);
  byEntries.set(entries, { scopeHashes, hashes });
  return hashes;
}

function buildEntryProjection(
  entries: Entries,
  inScope: ReadonlySet<number>,
  proposals: Map<number, ReviewProposal>,
) {
  const scoped = entries.filter((entry) => inScope.has(entry.hash));
  const byCategory = new Map<string, Entries>();
  const byGroup = new Map<string, Entries>();
  const byStatus = new Map<string, Entries>();
  const byProposal = new Map<boolean, Entries>();
  const search = new Map<number, string>();
  function add<K>(map: Map<K, Entries>, key: K, entry: Entries[number]) {
    const bucket = map.get(key);
    if (bucket) bucket.push(entry);
    else map.set(key, [entry]);
  }
  for (const entry of scoped) {
    add(byCategory, entry.category, entry);
    add(byGroup, categoryId(entry.category), entry);
    add(byStatus, entry.status, entry);
    add(byProposal, !!proposals.get(entry.hash)?.link, entry);
    search.set(entry.hash, `${entry.name} ${entry.hash}`.toLowerCase());
  }
  return { entries: scoped, index: { byCategory, byGroup, byStatus, byProposal, search } };
}

export function reviewEntryProjection(
  entries: Entries,
  inScope: ReadonlySet<number>,
  proposals: Map<number, ReviewProposal>,
) {
  // Selection, filters, and workspace remounts do not change these immutable
  // inputs. Keep the index until evidence, scope, or proposal identity changes.
  let byScope = entryProjections.get(entries);
  if (!byScope) entryProjections.set(entries, (byScope = new WeakMap()));
  let byProposals = byScope.get(inScope);
  if (!byProposals) byScope.set(inScope, (byProposals = new WeakMap()));
  const previous = byProposals.get(proposals);
  if (previous) return previous;
  const projection = buildEntryProjection(entries, inScope, proposals);
  byProposals.set(proposals, projection);
  return projection;
}

/** Remounts reuse the same native targets until entry evidence changes. */
export function reviewSidebarCategories(
  categories: Prepared['categories'],
  projection: EntryProjection,
  selected?: number,
) {
  let byProjection = sidebarProjections.get(categories);
  if (!byProjection) sidebarProjections.set(categories, (byProjection = new WeakMap()));
  const target = (id: string, hash?: number) => {
    const params = new URLSearchParams({
      view: 'entries',
      group: id,
      query: '',
      category: '',
      status: 'open',
      proposal: 'all',
    });
    if (hash) params.set('hash', String(hash));
    return `/compendium/review?${params}`;
  };
  let previous = byProjection.get(projection);
  if (!previous) {
    const base = categories.map(({ id, name }) => ({
      id,
      name,
      entryTarget: target(
        id,
        projection.index.byGroup.get(id)?.find((entry) => entry.status === 'open')?.hash,
      ),
    }));
    previous = { base, rows: base };
    byProjection.set(projection, previous);
  }
  if (selected === undefined) return previous.base;
  if (previous.selected === selected) return previous.rows;
  const rows = previous.base.map((category) => {
    const entry = projection.index.byGroup
      .get(category.id)
      ?.find((entry) => entry.hash === selected && entry.status === 'open');
    const entryTarget = entry ? target(category.id, entry.hash) : category.entryTarget;
    return entryTarget === category.entryTarget ? category : { ...category, entryTarget };
  });
  previous.selected = selected;
  previous.rows = rows.every((row, index) => row === previous.base[index]) ? previous.base : rows;
  return previous.rows;
}

export function preparedCategories(
  prepared: Prepared,
  entries: ReturnType<typeof applyReviewProgress>,
  restored: ReadonlySet<number>,
): Prepared['categories'] {
  // Immutable evidence and decisions already retain `entries` across mounts.
  // Empty restore sets are equivalent even when a new queue creates its own Set.
  const scope = restored.size ? restored : emptyRestored;
  let byEntries = categoryProjections.get(prepared);
  if (!byEntries) categoryProjections.set(prepared, (byEntries = new WeakMap()));
  let byScope = byEntries.get(entries);
  if (!byScope) byEntries.set(entries, (byScope = new WeakMap()));
  const previous = byScope.get(scope);
  if (previous) return previous;
  const currentEntries = new Map(entries.map((entry) => [entry.hash, entry]));
  const unchanged =
    !scope.size &&
    prepared.categories.every((category) =>
      category.entries.every((entry) => {
        const current = currentEntries.get(entry.hash);
        return (
          current?.status === entry.status &&
          current.next === entry.next &&
          current.stale === entry.stale
        );
      }),
    );
  const categories = unchanged
    ? prepared.categories
    : prepared.categories.map((category) => {
        const decorated = new Map(
          category.entries.map((entry) => [
            entry.hash,
            { ...entry, ...currentEntries.get(entry.hash), scopeRestored: scope.has(entry.hash) },
          ]),
        );
        const decorate = (entry: (typeof category.entries)[number]) => decorated.get(entry.hash)!;
        return {
          ...category,
          entries: category.entries.map(decorate),
          samples: category.samples.map(decorate),
          reasons: Object.fromEntries(
            Object.entries(category.reasons).map(([reason, items]) => [
              reason,
              items.map(decorate),
            ]),
          ) as typeof category.reasons,
        };
      });
  byScope.set(scope, categories);
  return categories;
}

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
  const input = reviewPreparationInput();
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inputPending = input.pending;
  function schedule() {
    // No deadline timeout: speculative work must wait when there is no idle time.
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run);
    else timer = setTimeout(() => run(), 16);
  }
  function run(deadline?: IdleDeadline) {
    if (cancelled || byCore!.has(core)) {
      input.dispose();
      return;
    }
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
        input.dispose();
        return;
      }
    }
    schedule();
  }
  schedule();
  return () => {
    cancelled = true;
    input.dispose();
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}
