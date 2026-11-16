import { z } from 'zod';
import { hashSchema, langSchema, publishMonth, validatePublishTime } from '@clarity/core';
import {
  checkNotBefore,
  isValidZone,
  nowMinute,
  scheduleBodyDigest,
  scheduleIntentPaths,
  schedulePreparationCapability,
  scheduleRequestSchema,
  signScheduleIntent,
  type Batch,
  type ScheduleIntent,
  type ScheduleRequest,
} from '@clarity/core/schedule';
import { RefRace, type GitHub } from '../github.js';
import { body, HttpError, json } from '../http.js';
import { signingKey } from '../publish.js';
import { cancelledLog, endSchedule } from './lifecycle.js';
import type { Identity } from '../types.js';
import {
  by,
  checkedBatch,
  appendEvent,
  archivedCounter,
  child,
  memberCap,
  memberHashes,
  readRoles,
  readAdmissionState as readState,
  refuseClaimed,
  refuseRevision,
  requireBatch,
  saveChangeCap,
  scheduledSaveChangeCap,
  scheduleRoles,
  switches,
  withDueEntry,
  withoutDueEntry,
  type ScheduleState,
} from './store.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = scheduleRequestSchema.shape.requestId;
const scheduleInput = z
  .object({ requestId, revision, notBefore: z.string(), zone: z.string().min(1).max(64) })
  .strict();
const shallowTooltip = z.looseObject({
  hash: hashSchema,
  text: z.partialRecord(langSchema, z.looseObject({ text: z.string(), updatedAt: z.string(), updatedBy: z.string() })),
});
/** Only the envelope is interpreted here. Full tooltip validation belongs to the preparer. */
const saveInput = z
  .object({
    requestId,
    revision,
    changes: z
      .array(z.object({ hash: hashSchema, base: shallowTooltip.nullable(), next: shallowTooltip }).strict()
        .refine(({ hash, base, next }) => hash === next.hash && (!base || base.hash === hash)))
      .min(1)
      .max(saveChangeCap)
      .refine((changes) => new Set(changes.map(({ hash }) => hash)).size === changes.length),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
const endInput = z.object({ revision }).strict();
const retryInput = z.object({ revision, requestId }).strict();
const maxBytes = 300 * 1024;
const encoder = new TextEncoder();

function requirePreparation(): void {
  if (!switches.scheduled() || !switches.publisher() || !switches.preparation())
    throw new HttpError(503, 'Asynchronous batch preparation is not enabled');
}
function requireCapability(state: ScheduleState): void {
  const capabilities = (state.pin as { capabilities?: unknown } | null)?.capabilities;
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes('scheduledBatches') ||
    !capabilities.includes(schedulePreparationCapability)
  )
    throw new HttpError(422, `The installed publisher lacks ${schedulePreparationCapability}`);
}
function readRequest(state: ScheduleState): ScheduleRequest | undefined {
  const file = state.extra[0];
  return file ? scheduleRequestSchema.parse(file.value) : undefined;
}
function checkedRequest(record: ScheduleRequest, batchId: string, id: string): ScheduleRequest {
  if (record.batchId !== batchId || record.requestId !== id)
    throw new HttpError(502, 'Stored preparation request identity mismatch');
  return record;
}
function admissionEvent(
  github: GitHub,
  state: ScheduleState,
  batch: Batch,
  user: Identity,
  action: Batch['events'][number]['action'],
  at: string,
) {
  return appendEvent(
    batch,
    {
      at,
      by: by(user),
      action,
      revision: batch.revision + 1,
      contentRevision: batch.contentRevision,
    },
    archivedCounter(github, state.head, batch.id, child(state.trees[0], 'events')),
  );
}
function reply(
  state: ScheduleState,
  record: ScheduleRequest,
  commit: string | null = null,
): Response {
  const pending = record.status === 'pending';
  const kind = state.batch?.preparation?.kind;
  return json(
    {
      commit,
      requestId: record.requestId,
      status: record.status,
      batch: state.batch,
      message: pending ? (kind === 'schedule' ? 'Schedule requested' : 'Save queued') : undefined,
      request: record,
    },
    pending ? 202 : 200,
  );
}

/** Read bytes once, bounded even with a missing or dishonest Content-Length. */
async function submitted(
  request: Request,
): Promise<{ raw: string; value: unknown; digest: string }> {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, 'Request exceeds 300 KiB');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let raw: string;
  let value: unknown;
  try {
    raw = decoder.decode(bytes);
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid UTF-8 JSON');
  }
  // Preserve exact bytes, including a UTF-8 BOM, through the rawFiles commit API.
  if (encoder.encode(raw).length !== bytes.length)
    throw new HttpError(400, 'Noncanonical UTF-8 JSON');
  return { raw, value, digest: await scheduleBodyDigest(bytes) };
}

/** Directory metadata only: its tooltips entry carries Git's immutable subtree OID. */
async function memberTreeOid(
  github: GitHub,
  state: ScheduleState,
  batchId: string,
): Promise<string | null> {
  const value = await github.result(`/contents/schedule/batches/${batchId}?ref=${state.head}`);
  const entries = z
    .array(
      z.object({ name: z.string(), type: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    )
    .max(8)
    .parse(value);
  const members = entries.find(({ name }) => name === 'tooltips');
  if (members && members.type !== 'dir')
    throw new HttpError(502, 'Batch members are not a directory');
  return members?.sha ?? null;
}

/** No member bodies, catalogs, snapshots, resolver, composition, or approvedDigest. */
export async function admitBatchRequest(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
  kind: 'schedule' | 'save',
): Promise<Response> {
  requirePreparation();
  const submittedBody = await submitted(request);
  const parsed = (kind === 'schedule' ? scheduleInput : saveInput).safeParse(submittedBody.value);
  if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
  const input = parsed.data;
  const id = input.requestId;
  if (kind === 'schedule' && !/^\d{4}-\d{2}$/.test(publishMonth(id)))
    throw new HttpError(400, 'Schedule requestId outside creation window');
  const operationPaths = kind === 'schedule'
    ? [`publish/requests/${id}.json`, `publish/log/${publishMonth(id)}/${id}.json`] : [];
  let envelope: ScheduleRequest['envelope'] | undefined;
  let returnStatus: 'draft' | 'scheduled' = 'draft';
  let target: { notBefore: string; zone: string } | undefined;
  let firstSource: { contentRevision: number; tree: string | null } | undefined;
  let ambiguous: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, kind === 'save' ? readRoles : scheduleRoles, {
      batchId,
      extra: [scheduleIntentPaths.request(id), ...operationPaths],
      oidOnly: operationPaths,
      trees: [{ path: `schedule/batches/${batchId}`, depth: 2 }],
    });
    requireCapability(state);
    const batch = requireBatch(state, batchId);
    const existing = readRequest(state);
    if (existing) {
      if (existing.batchId !== batchId || existing.requestId !== id)
        throw new HttpError(409, 'This requestId was used for different input');
      if (existing.requesterId !== user.id || existing.bodyDigest !== submittedBody.digest)
        throw new HttpError(409, 'This requestId was used for different input');
      return reply(state, existing);
    }
    if (kind === 'schedule') {
      if (state.extra[1] || state.extra[2]) throw new HttpError(409, 'requestId already names a publication operation');
      try { validatePublishTime(id, Date.now()); }
      catch { throw new HttpError(400, 'Schedule requestId outside creation window'); }
    }
    if (ambiguous && !(ambiguous instanceof RefRace)) throw ambiguous;
    refuseClaimed(batch);
    refuseRevision(batch, input.revision);
    if (batch.status !== 'draft' && batch.status !== 'scheduled')
      throw new HttpError(409, 'This batch cannot be changed');
    const hashes = memberHashes(child(state.trees[0], 'tooltips'));
    if (hashes.length > memberCap)
      throw new HttpError(422, `A batch holds at most ${memberCap} tooltips`);
    returnStatus = kind === 'schedule' || batch.status === 'scheduled' ? 'scheduled' : 'draft';
    if ('changes' in input) {
      if (batch.status === 'scheduled' && state.access.role === 'translator' && !switches.translatorScheduledSaves())
        throw new HttpError(403, 'Scheduled batch saves require an editor or maintainer');
      if (state.access.role === 'translator' && input.changes.some(({ base }) => base === null))
        throw new HttpError(403, 'Translators may change only existing tooltips');
      if (batch.status === 'scheduled' && input.changes.length > scheduledSaveChangeCap)
        throw new HttpError(
          422,
          `A scheduled batch takes at most ${scheduledSaveChangeCap} changes per save`,
        );
      const adds = input.changes.filter(({ hash }) => !hashes.includes(hash));
      if (state.access.role === 'translator' && adds.length)
        throw new HttpError(403, 'Translators may change only tooltips already in the batch');
      if (batch.status === 'scheduled' && adds.length)
        throw new HttpError(409, 'Unschedule to edit');
      if (hashes.length + adds.length > memberCap)
        throw new HttpError(422, `A batch holds at most ${memberCap} tooltips`);
      // Assigned-language authority is checked against the current accepted proposal offline.
      if (state.access.role === 'translator' && !state.access.languages?.length)
        throw new HttpError(403, 'No assigned languages');
    } else {
      if (!hashes.length) throw new HttpError(422, 'Add a tooltip to the batch first');
      if (!isValidZone(input.zone)) throw new HttpError(400, 'Unknown time zone');
      if (!target) {
        const notBefore = input.notBefore === 'now' ? nowMinute(Date.now()) : input.notBefore;
        const check =
          input.notBefore === 'now' ? { ok: true as const } : checkNotBefore(notBefore, Date.now());
        if (!check.ok) throw new HttpError(422, check.reason);
        target = { notBefore, zone: input.zone };
      }
    }
    const at = new Date().toISOString();
    if (!envelope) {
      const tree = await memberTreeOid(github, state, batchId);
      if (hashes.length && !tree) throw new HttpError(502, 'Batch member tree is unreadable');
      firstSource = { contentRevision: batch.contentRevision, tree };
      const common = {
        version: 1 as const,
        kind,
        requestId: id,
        batchId,
        repo: `${github.env.GITHUB_OWNER}/${github.env.GITHUB_REPO}`,
        dataBranch: github.env.DATA_BRANCH,
        liveBranch: github.env.LIVE_BRANCH,
        requester: by(user),
        expectedRevision: batch.revision,
        contentRevision: batch.contentRevision,
        sourceCommit: state.head,
        memberTreeOid: tree,
        createdAt: at,
        bodyDigest: submittedBody.digest,
      };
      const intent: ScheduleIntent =
        kind === 'schedule' ? { ...common, kind, ...target! } : { ...common, kind, returnStatus };
      envelope = await signScheduleIntent(intent, (await signingKey(github.env)).key);
    } else if (batch.contentRevision !== firstSource!.contentRevision) {
      throw new HttpError(409, 'Batch content changed; use a new requestId');
    }
    const appended = await admissionEvent(github, state, batch, user, 'request', at);
    const next = checkedBatch({
      ...batch,
      events: appended.events,
      revision: batch.revision + 1,
      status: 'preparing',
      claim: null,
      preparedRequestId: null,
      preparation: { requestId: id, kind, returnStatus, requestedAt: at, attempt: 1 },
      ...(target ? { ...target, opId: id, scheduledContentRevision: null } : {}),
    });
    const record: ScheduleRequest = {
      envelope,
      requestId: id,
      batchId,
      requesterId: user.id,
      bodyDigest: submittedBody.digest,
      admissionRevision: next.revision,
      status: 'pending',
      attempt: 1,
      updatedAt: at,
    };
    const files: Record<string, unknown> = {
      [scheduleIntentPaths.request(id)]: record,
      [`schedule/batches/${batchId}/batch.json`]: next,
      ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
    };
    const deletions: string[] = [];
    // Withdraw an older ready request in the SAME CAS. Preserve its signed approval for B.
    if (batch.opId) {
      const path = `publish/requests/${batch.opId}.json`;
      const [publication, log] = await github.files(
        [path, `publish/log/${publishMonth(batch.opId)}/${batch.opId}.json`],
        state.head,
      );
      if (log || !publication) throw new HttpError(409, 'Publishing started');
      files[scheduleIntentPaths.publication(batchId)] = publication.value;
      if (kind === 'schedule') files[`publish/log/${publishMonth(batch.opId)}/${batch.opId}.json`] = cancelledLog(publication, user, at, 'rescheduled');
      deletions.push(path);
    }
    if (returnStatus === 'scheduled')
      files['schedule/due.json'] = withDueEntry(state.due, {
        batchId,
        opId: next.opId!,
        notBefore: next.notBefore!,
        claimed: false,
      });
    try {
      const commit = await github.commit(
        state.head,
        files,
        `${kind === 'schedule' ? 'Request schedule' : 'Queue save'} for batch "${batch.name}"`,
        user,
        {
          baseTree: state.tree,
          deletions,
          rawFiles: { [scheduleIntentPaths.body(id)]: submittedBody.raw },
        },
      );
      return reply({ ...state, batch: next }, record, commit);
    } catch (error) {
      ambiguous = error;
    }
  }
  // The last failed/ambiguous CAS still gets one reconciliation, never an unconfirmed 202.
  const state = await readState(github, user, kind === 'save' ? readRoles : scheduleRoles, {
    batchId,
    extra: [scheduleIntentPaths.request(id)],
  });
  const existing = readRequest(state);
  if (existing && existing.requesterId === user.id && existing.bodyDigest === submittedBody.digest)
    return reply(state, checkedRequest(existing, batchId, id));
  if (ambiguous && !(ambiguous instanceof RefRace)) throw ambiguous;
  throw new HttpError(409, 'Data branch kept moving; retry with the same requestId');
}

/** Authenticated status read; returning a record never asserts that submitted edits are saved. */
export async function batchRequestStatus(
  github: GitHub,
  user: Identity,
  batchId: string,
  requestedId?: string,
): Promise<Response> {
  if (requestedId !== undefined && !requestId.safeParse(requestedId).success)
    throw new HttpError(400, 'Invalid requestId');
  const state = await readState(github, user, readRoles, { batchId });
  const batch = requireBatch(state, batchId);
  const id = requestedId ?? batch.preparation?.requestId;
  if (!id) return json({ batch, request: null });
  const [file] = await github.files([scheduleIntentPaths.request(id)], state.head);
  if (!file) throw new HttpError(502, 'Preparation request is unreadable');
  return reply(state, checkedRequest(scheduleRequestSchema.parse(file.value), batchId, id));
}

/** Retry the SAME immutable intent after an infrastructure failure; edits require a new intent. */
export async function retryBatchRequest(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  requirePreparation();
  const input = await body(request, retryInput, 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, readRoles, {
      batchId,
      extra: [scheduleIntentPaths.request(input.requestId)],
      trees: [{ path: `schedule/batches/${batchId}`, depth: 2 }],
    });
    requireCapability(state);
    const batch = requireBatch(state, batchId);
    const record = readRequest(state);
    if (!record || batch.preparation?.requestId !== input.requestId)
      throw new HttpError(409, 'This request is no longer outstanding');
    checkedRequest(record, batchId, input.requestId);
    if (
      state.access.role === 'translator' &&
      (record.requesterId !== user.id || batch.preparation.kind !== 'save')
    )
      throw new HttpError(403, 'Permission denied');
    if (record.status === 'pending' && batch.status === 'preparing') return reply(state, record);
    refuseRevision(batch, input.revision);
    if (
      batch.claim ||
      batch.status !== 'needs_attention' ||
      record.status !== 'needs_attention' ||
      !record.retryable
    )
      throw new HttpError(409, 'Return to draft and submit a fresh request');
    const at = new Date().toISOString();
    const appended = await admissionEvent(github, state, batch, user, 'retry', at);
    const next: Batch = checkedBatch({
      ...batch,
      events: appended.events,
      status: 'preparing',
      revision: batch.revision + 1,
      preparation: { ...batch.preparation, attempt: record.attempt + 1 },
    });
    const retried: ScheduleRequest = {
      ...record,
      status: 'pending',
      attempt: record.attempt + 1,
      admissionRevision: next.revision,
      updatedAt: at,
    };
    try {
      const commit = await github.commit(
        state.head,
        {
          [scheduleIntentPaths.request(input.requestId)]: retried,
          [`schedule/batches/${batchId}/batch.json`]: next,
          ...(next.preparation?.returnStatus === 'scheduled' ? {
            'schedule/due.json': withDueEntry(state.due, {
              batchId, opId: next.opId!, notBefore: next.notBefore!, claimed: false,
            }),
          } : {}),
          ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
        },
        `Retry preparation for batch "${batch.name}"`,
        user,
        { baseTree: state.tree },
      );
      return reply({ ...state, batch: next }, retried, commit);
    } catch (error) {
      if (!(error instanceof RefRace)) {
        const fresh = await readState(github, user, readRoles, {
          batchId,
          extra: [scheduleIntentPaths.request(input.requestId)],
        });
        const found = readRequest(fresh);
        if (
          found &&
          found.batchId === batchId &&
          found.envelope.sig === record.envelope.sig &&
          found.attempt === retried.attempt &&
          ['pending', 'completed', 'needs_attention', 'cancelled'].includes(found.status)
        )
          return reply(fresh, found);
        throw error;
      }
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

/** Cancel/unschedule pending or failed preparations without reading member or archive bodies. */
export async function endBatchRequest(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
  action: 'unschedule' | 'cancel',
): Promise<Response> {
  const legacyRequest = request.clone();
  const input = await body(request, endInput, 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, scheduleRoles, {
      batchId,
      trees: [{ path: `schedule/batches/${batchId}`, depth: 2 }],
    });
    const batch = requireBatch(state, batchId);
    if (!batch.preparation) return endSchedule(legacyRequest, github, user, batchId, action);
    refuseRevision(batch, input.revision);
    if (
      batch.claim ||
      !batch.preparation ||
      !['preparing', 'needs_attention'].includes(batch.status)
    )
      throw new HttpError(409, 'No unclaimed preparation to cancel');
    const id = batch.preparation.requestId;
    const [file, publication, publicationLog] = await github.files([
      scheduleIntentPaths.request(id), scheduleIntentPaths.publication(batchId),
      ...(batch.opId ? [`publish/log/${publishMonth(batch.opId)}/${batch.opId}.json`] : []),
    ], state.head);
    if (!file) throw new HttpError(502, 'Preparation request is unreadable');
    const record = checkedRequest(scheduleRequestSchema.parse(file.value), batchId, id);
    if (publicationLog) throw new HttpError(409, 'Publication operation is already terminal');
    const at = new Date().toISOString();
    const appended = await admissionEvent(github, state, batch, user, action, at);
    const next: Batch = checkedBatch({
      ...batch,
      events: appended.events,
      revision: batch.revision + 1,
      status: action === 'cancel' ? 'cancelled' : 'draft',
      preparation: null,
      preparedRequestId: null,
      opId: null,
      notBefore: null,
      zone: null,
      scheduledContentRevision: null,
    });
    try {
      const commit = await github.commit(
        state.head,
        {
          [scheduleIntentPaths.request(id)]: { ...record, status: 'cancelled', updatedAt: at },
          [`schedule/batches/${batchId}/batch.json`]: next,
          'schedule/due.json': withoutDueEntry(state.due, batchId),
          ...(batch.opId ? { [`publish/log/${publishMonth(batch.opId)}/${batch.opId}.json`]: cancelledLog(
            batch.preparation.kind === 'save' ? publication ?? null : { sha: state.head, value: record.envelope }, user, at, action,
          ) } : {}),
          ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
        },
        `${action === 'cancel' ? 'Cancel' : 'Unschedule'} preparation for batch "${batch.name}"`,
        user,
        { baseTree: state.tree },
      );
      return json({ commit, requestId: id, batch: next });
    } catch (error) {
      if (!(error instanceof RefRace)) {
        const fresh = await readState(github, user, scheduleRoles, {
          batchId,
          extra: [scheduleIntentPaths.request(id)],
        });
        const found = readRequest(fresh);
        if (
          found?.batchId === batchId &&
          found.status === 'cancelled' &&
          fresh.batch?.preparation == null &&
          fresh.batch?.status === next.status
        )
          return json({ commit: null, requestId: id, batch: fresh.batch });
        throw error;
      }
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}
