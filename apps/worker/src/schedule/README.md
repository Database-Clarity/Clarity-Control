# Scheduled batches: Worker (phase P2)

Spec: `.agents/reports/scheduled-changes/spec.md` ("Worker API", "Permissions", "Publication
path" 1-2, "Free-plan budget"). Contracts come from `@clarity/core/schedule` (P1); this folder
is admission only: the publisher re-checks everything at the claim (I1).

## Switches (I6)

- `config/scheduled.json` OFF (the default): every `/batches` route answers 503 before
  authentication, and the per-minute cron makes no I/O. `config/publisher.json` OFF also keeps
  the cron silent and refuses schedule and kick (503).
- ON, scheduling needs the `.publisher/PIN` capability `scheduledBatches` (422 without it) and
  the enable-time `PUBLISH_SIGNING_KEY` (503 without it).

## Caps (CPU gate, root 2026-11-13 option A)

- `memberCap` = 25 members per batch (core allows 100): scheduling validates every member in
  ONE request inside the Workers Free 10 ms CPU limit. A workflow limit, one constant in
  `store.ts`, so it can move with the measured gate.
- `saveChangeCap` = 25 changes per batch save request; the web chunks larger saves (P3a).
- `memberByteCap` = 8 KiB per stored member file (the largest real tooltip is 2,112 bytes).
- Gate: `node scripts/publisher/cpu/schedule.mjs` (local, real largest tooltips, worst stored
  files). Each case's p99 must be at most the existing /publish-100 p99 in the same run; the
  remote run on a throwaway Worker is OPEN for P5.

## Routes (`routes.ts`)

| Route                                     | Roles                                              | Notes                                                  |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `GET /batches`                            | maintainer, editor, translator                     | `{head, index}`; members are read from raw at `head`   |
| `POST /batches {name}`                    | maintainer, editor                                 | ≤50 open batches (by the index: a storage bound)       |
| `POST /batches/:id/save`                  | maintainer, editor; translator on existing members | /save semantics against the stored proposals           |
| `POST /batches/:id/rebase`                | maintainer, editor                                 | draft only; base = current at the head                 |
| `POST /batches/:id/remove`                | maintainer, editor                                 | draft only                                             |
| `POST /batches/:id/schedule`              | maintainer, editor                                 | draft or scheduled (reschedule)                        |
| `POST /batches/:id/unschedule`, `/cancel` | maintainer, editor                                 | unclaimed only                                         |
| `POST /batches/:id/resolve`               | maintainer, editor                                 | published batches with a conflict file                 |
| `POST /batches/:id/kick`                  | maintainer, editor                                 | overdue (> notBefore + 5 min), scheduled or publishing |

Trials get no batch access at all (Q3). Every write reads ONE head (`readState`: permissions,
PIN, due, index, batch, and names-only listings in one GraphQL read), checks the client's
`revision`, refuses any claimed batch with 409 "Publishing started" (I2), and commits by CAS on
editor-data with 3 RefRace attempts.

- Q2 (one open batch per tooltip): an added hash is refused when another batch directory at the
  CAS head lists it under `tooltips/` and that batch's `batch.json` is open. `index.json` is
  never the guard.
- Permissions: `checkEdit(access, storedProposed, next)` before and after the merge (archive
  rules included); adds check against current; removing checks the proposal → base revert.
  Translators edit only their languages of existing members and never add, remove, or rebase.
- A scheduled batch takes translation-only saves (contentRevision unchanged, I5); anything
  else is 409 "Unschedule to edit".
- Schedule composes every member (C1-C4) and refuses: `stale` (C3), `unpublished` fields (root
  ruling after P1), a non-translation merge3 conflict or `$exists` against current (R14), a hash
  with an activation conflict file, and every manual-publish check on the composed tooltips
  (textless, base/enhanced imports and associations, element tags the PIN lowers, held set
  bonuses). Generator facts are checked by the publisher at the claim (P4).
- Reschedule, unschedule, and cancel remove the request and write its terminal log with
  `result.status: 'cancelled'` in the same commit; `/publish/status` reports `cancelled`.
- Resolve maps an existence choice that no longer applies to 409 with per-field `missing`.

## Event overflow (root ruling 2026-11-13, shared with the publisher)

`batch.json` keeps the newest 200 events. A write that overflows moves the oldest events, in the
SAME commit as that batch.json write, to `schedule/batches/<id>/events/<seq>.json` with body
`{events: [...]}` oldest first, where `seq` is the zero-padded 8-digit count of events archived
before this file (the first file is `00000000.json`). Helpers: `eventArchivePath` and
`appendEvent` in `store.ts`; the count is the latest file's seq plus its event count.

## Cron (`lifecycle.ts` `scheduleTick`)

`scheduled()` dispatches by `event.cron`: `* * * * *` runs the tick, every other trigger keeps
the hourly report purge. The tick reads `schedule/due.json` (one GraphQL read) and writes at
most one kick, `publish/kicks/due-<latest due notBefore, YYYYMMDDHHMM>-<floor(epoch minute /
10)>.json`, created without a sha (a duplicate gets 422 and is ignored). Claimed entries count,
so a claimed batch whose run died is re-kicked every 10 minutes (R11). The trigger itself is
gate G1 (phase P5); wrangler.jsonc is unchanged.

## /publish admission (`publish.ts`)

While the switch is ON, a names-only listing of `schedule/activation-conflicts` joins the
existing snapshot read (0 extra subrequests) and a hash with a conflict file is refused (R3).
