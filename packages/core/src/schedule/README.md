# `@clarity/core/schedule`

Pure contracts for scheduled changes (spec: `.agents/reports/scheduled-changes/spec.md`, phase
P1). Import ONLY as `@clarity/core/schedule`; the core barrel never re-exports it, so the
publisher bundle (and its PIN) stays unchanged until P4 imports it. No I/O, no clock reads
except where a function takes `now`.

## Files and storage (`schemas.ts`)

- `batchSchema`: `schedule/batches/<id>/batch.json`. Status invariants: draft and cancelled carry no `opId`, `claim`, or `scheduledContentRevision`; scheduled has all three set except `claim`; publishing and published are claimed by their own `opId`; published carries its own published or unchanged `result`.
- `batchMemberSchema`: `schedule/batches/<id>/tooltips/<hash>.json`; `base` null = the batch creates the tooltip.
- `dueSchema`: `schedule/due.json`; one entry per batch and per opId, ≤50.
- `scheduleIndexSchema`: `schedule/index.json`; ≤50 open + ≤100 terminal; derived, never a guard.
- `activationConflictSchema`: `schedule/activation-conflicts/<hash>.json`; `fields` = conflicted, `changed` = ALL batch-changed fields (must equal `changedFields(base, proposed)`).
- `notBeforeSchema`: canonical whole UTC minute `YYYY-MM-DDTHH:MM:00.000Z` (string order = time order).
- `schedulePaths`, `scheduleLimits`: editor-data paths and every bound from the spec (open batches, members, events, lead times, overdue).

Choices made inside the spec's latitude: events carry `by: {id, login}`; a new batch starts at
`initialRevisions` `{revision: 1, contentRevision: 0}`; `result.error` holds the reason a run
failed ("Last run failed: <reason>"), with per-hash detail in `result.outcomes`.

## Changed fields (`fields.ts`, R17)

`changedFields(base, proposed)` is the ONE set every phase uses (save validation, no-op
detection, approvedDigest, composition, activation): every key merge3 merges (`text.<lang>`,
`associated`, every other Tooltip key) where base and proposed differ. Text entries and the
Bungie snapshot compare by content (merge3's stamped rule): stamp-only differences
(`updatedAt`, `updatedBy`, `sourceUpdatedAt`, `snapshotAt`) are no-ops and never publish or
activate. `base` null compares against an empty tooltip. `isTranslationField` = `text.<lang>`
for every language but English.

## Approval and revisions (`digest.ts`, `revisions.ts`)

- `approvedDigest(members)` = SHA-256 of `approvalInput`: members sorted by hash, each with its
  full `base` and its `proposed` without translations. Translation saves never change it; add,
  remove, a rebase that moves a base, and any other field change do (I5).
- `isContentChange(before, after)` is true exactly when `approvalInput` changes;
  `nextRevisions(current, contentChanged)` bumps `revision` always and `contentRevision` only
  then. So a scheduled batch's `contentRevision` and its signed digest cannot disagree.
- `batchPublishPayloadSchema` and `batchIntentDigest`: the `kind: 'batch'` request. P4 joins it
  with `push` in `publishRequest.ts`; the `push` intent digest is pinned by a golden in
  `schedule.test.ts` and must stay byte-identical.

## Composition (`compose.ts`, C1-C4, I3)

`compose({hash, base, proposed, snapshot, pushed})` never reads current saved data:

- `overlay` (C1-C2): snapshot at S with every batch-changed field taken from `proposed`
  (absent there = removed).
- `stale` (C3): pushed but no snapshot; reason `missingSnapshotReason`.
- `whole` (C4): never published, or `base` null (the batch creates it): the whole proposal.

## Activation and resolution (`activate.ts`, I4, Q4, R12, R14)

- `activate({base, current, proposed})`: merge3 restricted to the batch-changed fields; fields
  the batch did not change keep current. Q4: a translation the batch changed takes the
  upcoming value (including a removal) even if current changed meanwhile. Existence:
  base null + current absent creates; base null + current present, or base + current absent,
  is a `$exists` conflict. The same function decides schedule-time and claim-time staleness
  (clean = schedulable) and RECORD's per-member write or conflict file.
- `resolveActivation({..., choices})`: re-merges against current at the resolving head. Clean
  fields take the batch value; every conflicted field needs a choice (else `missing`, 409); an
  explicit choice on any batch-changed field is applied; a choice for any other field throws.
  `$exists`: `upcoming` writes the whole proposal, `current` keeps current.

## Time (`zone.ts`)

- `zonedToUtc(date, time, zone)` → `exact` | `overlap` (both instants, earlier first; ask
  which) | `gap` (refuse). Throws on malformed input or an unknown zone.
- `checkNotBefore(notBefore, now)`: at least 3 minutes and at most 366 days ahead;
  `nowMinute(now)` is "Publish now". `zoneOffsetMinutes` and `isValidZone` for display.

## Not here

Worker admission (roles, Q2 one open batch per tooltip, Q3 no trial access, CAS, caps) is P2;
the claim, candidate, and RECORD writes are P4; drafts are P3-0.
