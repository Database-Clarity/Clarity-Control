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
