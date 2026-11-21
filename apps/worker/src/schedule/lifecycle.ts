import { z } from 'zod';
import { refuseScheduleMembers as refuseMembers, validateScheduleMembers } from './validation.js';
import {
  publishMonth,
  aliasGroupsPath,
  sandboxPointersPath,
  stableStringify,
  hasUnpublishedInactiveMove,
  unreviewedInactiveMessage,
} from '@clarity/core';
import {
  approvedDigest,
  batchIntentDigest,
  batchPublishPayloadSchema,
  checkNotBefore,
  dueSchema,
  isValidZone,
  notBeforeSchema,
  nowMinute,
  scheduleLimits,
  schedulePaths,
  type Batch,
} from '@clarity/core/schedule';
import { refuseBaseEnhanced } from '../baseEnhanced.js';
import { loadAliases } from '../catalog.js';
import { refuseUnlowerable } from '../elementTags.js';
import { GitHub, RefRace, type RepoFile } from '../github.js';
import { body, HttpError, json } from '../http.js';
import { signingKey } from '../publish.js';
import { endBatchRequest } from './admission.js';
import {
  pinMergesSandboxPointers,
  consumerAliasScope,
  refuseUnsupportedAliasGroups,
  withSandboxPointers,
} from '../sandboxPointers.js';
import { pinAppliesInactiveMoves, storedInactiveMoves } from '../inactiveMoves.js';
import { inactiveMovesPath, isMovedInactive, selectedInactiveMoves } from '@clarity/core';
import { refuseHeldSetBonuses } from '../setBonusHold.js';
import type { Env, Identity } from '../types.js';
import {
  appendEvent,
  archivedCounter,
  by,
  checkedBatch,
  child,
  indexEntry,
  pushedHashes,
  refuseAliases,
  memberHashes,
  newUlid,
  pinSchedulesBatches,
  parseIndex,
  readState,
  refuseClaimed,
  globalsListing,
  refuseGlobalScheduling,
  refuseOpenCap,
  refuseRevision,
  requireBatch,
  scheduleRoles,
  scheduledBatchesCapability,
  switches,
  withDueEntry,
  withIndexEntry,
  withoutDueEntry,
  type ScheduleState,
} from './store.js';

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scheduleSchema = z
  .object({
    revision: revisionSchema,
    notBefore: z.union([notBeforeSchema, z.literal('now')]),
    zone: z.string().min(1).max(64),
  })
  .strict();
const revisionOnlySchema = z.object({ revision: revisionSchema }).strict();
const envelopeSchema = z.object({ payload: z.string(), sig: z.string() }).strict();
const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const opPaths = (opId: string) => ({
  request: `publish/requests/${opId}.json`,
  log: `publish/log/${publishMonth(opId)}/${opId}.json`,
});

function requirePublisher(): void {
  if (!switches.publisher()) throw new HttpError(503, 'Publisher is not enabled');
}

/**
 * The terminal log of an operation the Worker removes before any run (reschedule, unschedule,
 * cancel): publish/status reports 'cancelled'. Shape follows the publisher's RECORD log.
 */
export function cancelledLog(request: RepoFile | null, user: Identity, at: string, reason: string) {
  let intentDigest: string | null = null;
  try {
    intentDigest = request
      ? ((JSON.parse(envelopeSchema.parse(request.value).payload) as { intentDigest?: string })
          .intentDigest ?? null)
      : null;
  } catch {
    intentDigest = null;
  }
  return {
    request: request?.value ?? null,
    intentDigest,
    candidateCommit: null,
    result: { status: 'cancelled', reason, by: by(user), at },
    liveCommit: null,
    recordCommit: null,
    times: { now: at },
  };
}

/**
 * Reads the operation a scheduled batch carries. A logged operation is already terminal, which a
 * scheduled batch.json can only disagree with mid-claim, so it refuses as "Publishing started".
 */
async function scheduledOperation(github: GitHub, state: ScheduleState, batch: Batch) {
  if (batch.status !== 'scheduled' || !batch.opId) return undefined;
  const paths = opPaths(batch.opId);
  const [request, log] = await github.files([paths.request, paths.log], state.head);
  if (log) throw new HttpError(409, 'Publishing started');
  return { paths, request };
}

/**
 * POST /batches/:id/schedule {revision, notBefore | 'now', zone} (spec "Publication path" 1).
 * Admission only: the publisher re-validates everything at the claim (I1).
 */
export async function scheduleBatch(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  requirePublisher();
  const input = await body(request, scheduleSchema, 4096);
  if (!isValidZone(input.zone)) throw new HttpError(400, 'Unknown time zone');
  const opId = newUlid();
  let generatorAliases: Awaited<ReturnType<typeof loadAliases>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, scheduleRoles, {
      batchId,
      extra: ['live/pushed.json', sandboxPointersPath, inactiveMovesPath, aliasGroupsPath],
      trees: [{ path: `schedule/batches/${batchId}`, depth: 2 }, globalsListing],
    });
    if (!pinSchedulesBatches(state.pin))
      throw new HttpError(
        422,
        `The publisher installed in the data branch cannot publish scheduled batches yet (.publisher/PIN lacks the "${scheduledBatchesCapability}" capability)`,
      );
    const { key } = await signingKey(github.env);
    const batch = requireBatch(state, batchId);
    refuseClaimed(batch);
    refuseRevision(batch, input.revision);
    if (batch.draftStaging)
      throw new HttpError(409, 'Finish saving the draft batch before scheduling');
    const hashes = memberHashes(child(state.trees[0], 'tooltips'));
    if (!hashes.length) throw new HttpError(422, 'Add a tooltip to the batch first');
    refuseGlobalScheduling(state.trees[1] ?? null);
    const rescheduling = batch.status === 'scheduled';
    if (!rescheduling && state.due.entries.length >= scheduleLimits.openBatches)
      throw new HttpError(409, `At most ${scheduleLimits.openBatches} scheduled batches`);
    const now = Date.now();
    const notBefore = input.notBefore === 'now' ? nowMinute(now) : input.notBefore;
    if (input.notBefore !== 'now') {
      const check = checkNotBefore(notBefore, now);
      if (!check.ok) throw new HttpError(422, check.reason);
    }
    const operation = await scheduledOperation(github, state, batch);
    if (!state.extra[3]) generatorAliases ??= await loadAliases(github.env, github);
    if (state.extra[3]) refuseUnsupportedAliasGroups(state.extra[3], state.pin);
    const scope = state.extra[3]
      ? await consumerAliasScope(github, state.extra[3], state.extra[1], hashes)
      : undefined;
    const saveAliases =
      scope?.aliases ?? (await withSandboxPointers(github, generatorAliases ?? {}, state.extra[1]));
    refuseAliases(hashes, saveAliases);
    // ONE read for every member, its current copy, its published snapshot, and any conflict file.
    const files = await github.files(
      hashes.flatMap((hash) => [
        schedulePaths.member(batchId, hash),
        `tooltips/${hash}.json`,
        `live/tooltips/${hash}.json`,
        schedulePaths.conflict(hash),
      ]),
      state.head,
    );
    const pushed = pushedHashes(state.extra[0]);
    const { members, composed, snapshots, first } = validateScheduleMembers(hashes, files, pushed);
    // The manual-publish checks (publish.ts) on what would publish: textless, imports and
    // associations (base/enhanced), element tags, `#{d}`, and `<enhanced/>` the PIN lowers, and held set bonuses.
    // A member the generator has since aliased would export its target, not the member: refuse
    // it as /save does, before any check reads documents by canonical hash.
    let aliases =
      state.extra[3] || pinMergesSandboxPointers(state.pin) ? saveAliases : generatorAliases!;
    const moves = storedInactiveMoves(state.extra[2]);
    if (
      Object.keys(selectedInactiveMoves(moves, hashes, aliases)).length &&
      !pinAppliesInactiveMoves(state.pin)
    )
      throw new HttpError(422, 'The installed publisher lacks the "inactiveMoves" capability');
    const pendingMoves: { hash: number; reason: string }[] = [];
    const markers = (state.extra[0]?.value ?? {}) as Record<string, string>;
    for (const hash of hashes)
      if (
        await hasUnpublishedInactiveMove(
          hash,
          snapshots.get(hash) ?? null,
          markers[hash],
          aliases,
          moves,
        )
      )
        pendingMoves.push({ hash, reason: unreviewedInactiveMessage });
    if (pendingMoves.length) refuseMembers(unreviewedInactiveMessage, pendingMoves);
    const active = composed.filter((tooltip) => !isMovedInactive(tooltip.hash, moves));
    const checked = active.length
      ? await refuseBaseEnhanced(
          github,
          state.head,
          active.map((t) => t.hash),
          aliases,
          active,
          scope,
        )
      : new Map();
    aliases = scope?.aliases ?? aliases;
    for (const document of checked.values())
      refuseUnlowerable(document, { value: state.pin }, 'published');
    refuseHeldSetBonuses(active);

    const at = new Date(now).toISOString();
    const intent = {
      kind: 'batch' as const,
      opId,
      repo: `${github.env.GITHUB_OWNER}/${github.env.GITHUB_REPO}`,
      dataBranch: github.env.DATA_BRANCH,
      liveBranch: github.env.LIVE_BRANCH,
      requester: by(user),
      batchId,
      contentRevision: batch.contentRevision,
      notBefore,
      hashes,
      approvedDigest: await approvedDigest(members),
    };
    const payloadValue = batchPublishPayloadSchema.parse({
      ...intent,
      createdAt: at,
      intentDigest: await batchIntentDigest(intent),
    });
    const payload = stableStringify(payloadValue);
    const sig = base64(await crypto.subtle.sign('Ed25519', key, encoder.encode(payload)));
    const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
    const appended = await appendEvent(
      batch,
      {
        at,
        by: by(user),
        action: rescheduling ? 'reschedule' : 'schedule',
        ...revisions,
        notBefore,
        hashes,
      },
      archivedCounter(github, state.head, batchId, child(state.trees[0], 'events')),
    );
    const next = checkedBatch({
      ...batch,
      ...revisions,
      status: 'scheduled',
      notBefore,
      zone: input.zone,
      opId,
      scheduledContentRevision: batch.contentRevision,
      events: appended.events,
    } satisfies Batch);
    const due = withDueEntry(state.due, { batchId, opId, notBefore, claimed: false });
    const files2: Record<string, unknown> = {
      [opPaths(opId).request]: { payload, sig },
      [schedulePaths.batch(batchId)]: next,
      [schedulePaths.due]: due,
      [schedulePaths.index]: withIndexEntry(state.index, indexEntry(next, hashes, at)),
      ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
    };
    const deletions: string[] = [];
    if (operation) {
      // A reschedule retires the old request in the same commit; its log records 'cancelled'.
      files2[operation.paths.log] = cancelledLog(operation.request, user, at, 'rescheduled');
      if (operation.request) deletions.push(operation.paths.request);
    }
    try {
      const commit = await github.commit(
        state.head,
        files2,
        `${rescheduling ? 'Reschedule' : 'Schedule'} batch "${batch.name}" for ${notBefore}\n\nClarity-Batch: ${batchId}`,
        user,
        { baseTree: state.tree, deletions },
      );
      return json({ commit, opId, batch: next, firstPublications: first }, 202);
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

/**
 * POST /batches/:id/unschedule and /cancel {revision}: unclaimed only (the claim fence, R2).
 * ONE commit removes the request, logs it 'cancelled', and updates batch.json, due, and index.
 */
export async function endSchedule(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
  action: 'unschedule' | 'cancel',
): Promise<Response> {
  const pendingRequest = request.clone();
  const input = await body(request, revisionOnlySchema, 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, scheduleRoles, {
      batchId,
      includeIndex: false,
      trees: [{ path: `schedule/batches/${batchId}`, depth: 2 }],
    });
    const batch = requireBatch(state, batchId);
    if (batch.preparation) return endBatchRequest(pendingRequest, github, user, batchId, action);
    const [indexFile] = await github.files([schedulePaths.index], state.head);
    state.index = indexFile ? parseIndex(indexFile.value) : { batches: [] };
    refuseClaimed(batch);
    refuseRevision(batch, input.revision);
    if (action === 'unschedule' && batch.status !== 'scheduled')
      throw new HttpError(409, 'This batch is not scheduled');
    if (action === 'unschedule') refuseOpenCap(state.index, batchId);
    const operation = await scheduledOperation(github, state, batch);
    const at = new Date().toISOString();
    const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
    const appended = await appendEvent(
      batch,
      {
        at,
        by: by(user),
        action,
        ...revisions,
        ...(batch.notBefore ? { notBefore: batch.notBefore } : {}),
      },
      archivedCounter(github, state.head, batchId, child(state.trees[0], 'events')),
    );
    const hashes = memberHashes(child(state.trees[0], 'tooltips'));
    const next = checkedBatch({
      ...batch,
      ...revisions,
      status: action === 'cancel' ? 'cancelled' : 'draft',
      ...(action === 'cancel' ? { memberHashes: hashes, draftStaging: undefined } : {}),
      preparedRequestId: null,
      notBefore: null,
      zone: null,
      opId: null,
      scheduledContentRevision: null,
      events: appended.events,
    } satisfies Batch);
    const files: Record<string, unknown> = {
      [schedulePaths.batch(batchId)]: next,
      [schedulePaths.index]: withIndexEntry(state.index, indexEntry(next, hashes, at)),
      ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
    };
    const deletions: string[] = [];
    if (state.due.entries.some((entry) => entry.batchId === batchId))
      files[schedulePaths.due] = withoutDueEntry(state.due, batchId);
    if (operation) {
      files[operation.paths.log] = cancelledLog(operation.request, user, at, action);
      if (operation.request) deletions.push(operation.paths.request);
    }
    try {
      const commit = await github.commit(
        state.head,
        files,
        `${action === 'cancel' ? 'Cancel' : 'Unschedule'} batch "${batch.name}"\n\nClarity-Batch: ${batchId}`,
        user,
        { baseTree: state.tree, deletions },
      );
      return json({ commit, batch: next });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

/** The scheduled-batches trigger (wrangler.jsonc triggers, gate G1, phase P5). */
export const minuteCron = '* * * * *';

/** `2026-12-03T17:00:00.000Z` → `202612031700` (kick names). */
const compactMinute = (notBefore: string) => notBefore.slice(0, 16).replace(/[-T:]/g, '');

/**
 * Creates a kick through the Contents API without a sha, so a second create of the same name
 * gets 422 and is ignored (one kick per name). An App-token push starts the pipeline.
 */
export async function createKick(github: GitHub, path: string, value: unknown): Promise<boolean> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await github.request(`/contents/${encoded}`, 'PUT', {
    branch: github.env.DATA_BRANCH,
    message: `Kick scheduled publishing (${path.slice(path.lastIndexOf('/') + 1)})`,
    content: btoa(`${JSON.stringify(value, null, 2)}\n`),
  });
  if (response.status === 422) return false;
  if (!response.ok) throw new HttpError(502, `GitHub kick failed (${response.status})`);
  return true;
}

/** One kick per batch per minute, shared by /kick and a pending Retry (same pipeline trigger). */
export const batchKickPath = (batchId: string, now: number) =>
  `publish/kicks/batch-${batchId}-${Math.floor(now / 60_000)}.json`;

/**
 * POST /batches/:id/kick: maintainer/editor; only an overdue batch (> notBefore + 5 min) that is
 * scheduled, or claimed but not terminal. At most one kick per batch per minute.
 */
export async function kickBatch(
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  requirePublisher();
  const state = await readState(github, user, scheduleRoles, { batchId });
  await signingKey(github.env); // kicks stay disabled until the enable-time secret exists
  const batch = requireBatch(state, batchId);
  const now = Date.now();
  if (batch.status !== 'scheduled' && batch.status !== 'publishing')
    throw new HttpError(409, 'Only a scheduled or publishing batch can be kicked');
  if (!batch.notBefore || now <= Date.parse(batch.notBefore) + scheduleLimits.overdueMs)
    throw new HttpError(409, 'This batch is not overdue');
  await createKick(github, batchKickPath(batchId, now), {
    batchId,
    opId: batch.opId,
    by: by(user),
  });
  return json({ batchId, opId: batch.opId, status: batch.status }, 202);
}

/**
 * The per-minute cron (spec "Publication path" 2): reads due.json (1 GraphQL read) and, if any
 * entry is due (claimed entries count, R11), writes AT MOST ONE kick per tick, named
 * `publish/kicks/due-<latest due notBefore minute>-<floor(epoch minute / 10)>.json`: a newly due
 * batch changes the name and kicks at once; a stuck set re-kicks every 10 minutes.
 * Switch OFF (scheduled or publisher): no I/O at all (I6).
 */
export async function scheduleTick(env: Env, now = Date.now()) {
  if (!switches.scheduled() || !switches.publisher()) return { status: 'off' as const };
  const github = new GitHub(env);
  const snapshot = await github.publishSnapshot([schedulePaths.due]);
  const due = snapshot.files[0] ? dueSchema.parse(snapshot.files[0].value) : { entries: [] };
  let latest: string | undefined;
  for (const entry of due.entries)
    if (Date.parse(entry.notBefore) <= now && (!latest || entry.notBefore > latest))
      latest = entry.notBefore;
  if (!latest) return { status: 'idle' as const };
  const path = `publish/kicks/due-${compactMinute(latest)}-${Math.floor(now / 600_000)}.json`;
  const created = await createKick(github, path, { due: latest });
  return { status: created ? ('kicked' as const) : ('duplicate' as const), path };
}
