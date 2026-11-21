import { createHash, createPublicKey, verify } from 'node:crypto';
import { stableStringify } from '@clarity/core';
import {
  approvedDigest,
  batchIntentDigest,
  batchPublishPayloadSchema,
  batchSchema,
  scheduleEnvelopeSchema,
  scheduleIntentSchema,
  scheduleRequestSchema,
  scheduleIntentPaths,
  scheduledStagingSchema,
  type ScheduleEnvelope,
  type BatchPublishPayload,
} from '@clarity/core/schedule';
import { batchMembers } from '../publisher/batch.js';
import { globalTreeOid } from '../publisher/globals.js';
import type { Tree } from '../publisher/git.js';
import type { Publisher } from '../publisher/publisher.js';

/** A derived manifest is never an authority: the original Worker signature and tree are. */
export interface PreparedPublication {
  payload: string;
  sig: string;
  sourceIntent: ScheduleEnvelope;
  preparedRequestId: string;
}
export class InvalidScheduleIntent extends Error {}

export function verifiedSource(pub: Publisher, raw: unknown) {
  const envelope = scheduleEnvelopeSchema.parse(raw);
  const key = createPublicKey(pub.options.publicKey);
  if (
    createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex') !== pub.options.keyFingerprint ||
    !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.sig, 'base64'))
  )
    throw new InvalidScheduleIntent('Invalid schedule signature or key pin');
  const intent = scheduleIntentSchema.parse(JSON.parse(envelope.payload));
  if (
    stableStringify(intent) !== envelope.payload ||
    intent.repo !== pub.options.repo ||
    intent.dataBranch !== pub.options.dataBranch ||
    intent.liveBranch !== pub.options.liveBranch
  )
    throw new InvalidScheduleIntent('Schedule intent target or canonical bytes mismatch');
  const tree = pub.git.tree(intent.sourceCommit);
  const batch = batchSchema.parse(pub.read(tree, `schedule/batches/${intent.batchId}/batch.json`));
  const members = batchMembers(pub, tree, intent.batchId);
  const oid = members.length
    ? globalTreeOid(
        tree,
        `schedule/batches/${intent.batchId}/tooltips`,
        pub.git.treeModes?.(intent.sourceCommit),
      )
    : null;
  if (
    batch.id !== intent.batchId ||
    batch.revision !== intent.expectedRevision ||
    batch.contentRevision !== intent.contentRevision ||
    oid !== intent.memberTreeOid ||
    batch.claim ||
    (intent.kind === 'save'
      ? batch.status !== intent.returnStatus
      : !['draft', 'scheduled'].includes(batch.status))
  )
    throw new InvalidScheduleIntent('Signed schedule source identity mismatch');
  if (
    batch.draftStaging &&
    (intent.kind !== 'save' ||
      intent.draftStaging?.id !== batch.draftStaging.id ||
      intent.requester.id !== batch.draftStaging.ownerId)
  )
    throw new InvalidScheduleIntent('The signed request does not own the unfinished draft save');
  return { intent, tree, batch, members };
}

export function verifiedRequest(pub: Publisher, tree: Tree, path: string) {
  const request = scheduleRequestSchema.parse(pub.read(tree, path));
  const source = verifiedSource(pub, request.envelope);
  const { intent } = source;
  const bodyOid = tree[scheduleIntentPaths.body(intent.requestId)];
  if (!bodyOid) throw new InvalidScheduleIntent('Missing submitted schedule bytes');
  const body = pub.git.blob(bodyOid);
  if (
    Buffer.byteLength(body) > 300 * 1024 ||
    createHash('sha256').update(body).digest('hex') !== intent.bodyDigest ||
    request.bodyDigest !== intent.bodyDigest ||
    request.requestId !== intent.requestId ||
    path !== scheduleIntentPaths.request(intent.requestId) ||
    request.batchId !== intent.batchId ||
    request.requesterId !== intent.requester.id ||
    request.admissionRevision <= intent.expectedRevision
  )
    throw new InvalidScheduleIntent('Schedule request or submitted bytes mismatch');
  const input = JSON.parse(body);
  if (input.requestId !== intent.requestId || input.revision !== intent.expectedRevision)
    throw new InvalidScheduleIntent('Submitted request identity mismatch');
  if (
    intent.kind === 'save' &&
    stableStringify(input.draftStaging ?? null) !== stableStringify(intent.draftStaging ?? null)
  )
    throw new InvalidScheduleIntent('Submitted draft save identity mismatch');
  if (intent.kind === 'save' && intent.scheduledParts) {
    const manifest = scheduledStagingSchema.parse(
      pub.read(source.tree, scheduleIntentPaths.stagedSave(intent.batchId)),
    );
    if (
      input.finish !== true ||
      manifest.id !== intent.requestId ||
      manifest.ownerId !== intent.requester.id ||
      manifest.parts !== intent.scheduledParts ||
      manifest.parts > source.members.length ||
      manifest.revision !== intent.expectedRevision ||
      manifest.ready
    )
      throw new InvalidScheduleIntent('Signed staged-save manifest mismatch');
    const changes: unknown[] = [];
    let message: string | undefined;
    for (let part = 0; part < manifest.parts; part++) {
      const oid = source.tree[scheduleIntentPaths.stagedPart(intent.batchId, manifest.id, part)];
      if (!oid) throw new InvalidScheduleIntent('Missing staged save part');
      const raw = pub.git.blob(oid);
      if (Buffer.byteLength(raw) > 300 * 1024)
        throw new InvalidScheduleIntent('Staged save part exceeds the request budget');
      const chunk = JSON.parse(raw);
      if (
        chunk.requestId !== intent.requestId ||
        chunk.revision !== intent.expectedRevision ||
        chunk.part !== part ||
        !Array.isArray(chunk.changes) ||
        typeof chunk.message !== 'string' ||
        (message !== undefined && message !== chunk.message)
      )
        throw new InvalidScheduleIntent('Invalid staged save part');
      message = chunk.message;
      changes.push(...chunk.changes);
    }
    return {
      ...source,
      request,
      input: { requestId: input.requestId, revision: input.revision, changes, message },
    };
  }
  return { ...source, request, input: input as unknown };
}

export async function schedulePayload(
  pub: Publisher,
  envelope: ScheduleEnvelope,
): Promise<BatchPublishPayload> {
  const { intent, members } = verifiedSource(pub, envelope);
  if (intent.kind !== 'schedule')
    throw new InvalidScheduleIntent('Publication requires a signed schedule approval');
  const approval = {
    kind: 'batch' as const,
    opId: intent.requestId,
    repo: intent.repo,
    dataBranch: intent.dataBranch,
    liveBranch: intent.liveBranch,
    requester: intent.requester,
    batchId: intent.batchId,
    contentRevision: intent.contentRevision,
    notBefore: intent.notBefore,
    hashes: members.map((m) => m.hash),
    approvedDigest: await approvedDigest(members),
  };
  return batchPublishPayloadSchema.parse({
    ...approval,
    createdAt: intent.createdAt,
    intentDigest: await batchIntentDigest(approval),
  });
}

export async function verifyPreparedPublication(
  pub: Publisher,
  raw: PreparedPublication,
  opId: string,
) {
  const payload = await schedulePayload(pub, raw.sourceIntent);
  if (
    raw.payload !== stableStringify(payload) ||
    raw.sig !== raw.sourceIntent.sig ||
    payload.opId !== opId
  )
    throw new InvalidScheduleIntent('Prepared publication differs from signed source approval');
  return payload;
}

export const publication = (
  payload: BatchPublishPayload,
  sourceIntent: ScheduleEnvelope,
  preparedRequestId: string,
): PreparedPublication => ({
  payload: stableStringify(payload),
  sig: sourceIntent.sig,
  sourceIntent,
  preparedRequestId,
});
