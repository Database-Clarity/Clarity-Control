import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  currentSaveIntent,
  currentSavePartBytes,
  currentSavePath,
  currentSaveStageLifetime,
  currentSaveStagePaths as paths,
  currentSaveStageRecord,
  currentSaveStagingCapability,
  permissionsSchema,
  publishOpIdSchema,
  stableStringify,
  type CurrentSaveStageRecord,
} from '@clarity/core';
import type { Publisher } from './publisher.js';
import { appCredits, RefRace, requesterCredits, type Tree } from './git.js';
import { json } from './batch.js';
import { hasGlobals } from './globals.js';
import {
  planSaveChanges,
  savedChangesSchema,
  currentSaveRoles,
} from '../../apps/worker/src/save.js';
import { globalAggregatePath } from '../../apps/worker/src/github.js';
import { requireAccess } from '../../apps/worker/src/permissions.js';
import { HttpError } from '../../apps/worker/src/http.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pinSchema = z.object({
  sourceSha: z.string(),
  sha256: z.string(),
  capabilities: z.array(z.string()),
});

function readSubmission(
  pub: Publisher,
  head: string,
  id: string,
  record: Extract<CurrentSaveStageRecord, { status: 'queued' }>,
) {
  const { payload, sig } = record.envelope;
  const key = createPublicKey(pub.options.publicKey);
  if (
    sha256(key.export({ type: 'spki', format: 'der' })) !== pub.options.keyFingerprint ||
    !verify(null, Buffer.from(payload), key, Buffer.from(sig, 'base64'))
  )
    throw new Error('Invalid staged Current save signature');
  const intent = currentSaveIntent.parse(JSON.parse(payload));
  if (
    stableStringify(intent) !== payload ||
    intent.requestId !== id ||
    intent.repo !== pub.options.repo ||
    intent.branch !== pub.options.dataBranch ||
    intent.parts !== record.parts ||
    stableStringify(intent.requester) !== stableStringify(record.requester) ||
    !pub.git.ancestor(intent.sourceCommit, head)
  )
    throw new Error('Staged Current save source identity changed');

  const source = pub.git.tree(intent.sourceCommit);
  const staged = currentSaveStageRecord.parse(pub.read(source, paths.record(id)));
  if (
    staged.status !== 'uploading' ||
    staged.parts !== intent.parts ||
    stableStringify(staged.requester) !== stableStringify(intent.requester)
  )
    throw new Error('Staged Current save manifest does not match its source');
  const chunks: Buffer[] = [];
  for (let part = 0; part < intent.parts; part++) {
    const raw = pub.read(source, paths.part(id, part));
    if (typeof raw !== 'string') throw new Error('Missing staged Current save part');
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length || bytes.length > currentSavePartBytes || bytes.toString('base64') !== raw)
      throw new Error('Invalid staged Current save part');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== intent.digest) throw new Error('Staged Current save content changed');
  return savedChangesSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
}

function requestIds(tree: Tree) {
  return Object.keys(tree)
    .flatMap((path) => {
      if (!path.startsWith(currentSavePath) || !path.endsWith('/request.json')) return [];
      const id = publishOpIdSchema.safeParse(
        path.slice(currentSavePath.length, -'/request.json'.length),
      );
      return id.success ? [id.data] : [];
    })
    .sort();
}

function discardStage(tree: Tree, id: string) {
  for (const path of Object.keys(tree)) if (path.startsWith(paths.prefix(id))) delete tree[path];
  delete tree[paths.kick(id)];
}

/** Both tooltip writes and their receipt become visible through one data ref CAS. */
export async function drainCurrentSaves(pub: Publisher) {
  const ref = `refs/heads/${pub.options.dataBranch}`;
  for (const id of requestIds(pub.git.tree(pub.head(pub.options.dataBranch)))) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = pub.head(pub.options.dataBranch);
      const tree = { ...pub.git.tree(head) };
      const record = currentSaveStageRecord.safeParse(pub.read(tree, paths.record(id)));
      if (!record.success) break;
      const started = record.data;
      const now = pub.options.now();
      if (
        started.status !== 'queued' &&
        now - Date.parse(started.updatedAt) < currentSaveStageLifetime
      )
        break;
      discardStage(tree, id);
      const outcome = { requester: started.requester, updatedAt: new Date(now).toISOString() };
      let parent = head;
      if (started.status === 'queued') {
        let plan: Awaited<ReturnType<typeof planSaveChanges>> | undefined;
        try {
          const input = readSubmission(pub, head, id, started);
          const access = requireAccess(
            permissionsSchema.parse(pub.read(tree, 'config/permissions.json')),
            started.requester,
            currentSaveRoles,
          );
          const pin = pinSchema.parse(pub.read(tree, '.publisher/PIN'));
          if (
            pin.sourceSha !== pub.options.publisherSha ||
            pin.sha256 !== pub.options.publisherDigest ||
            !pin.capabilities.includes(currentSaveStagingCapability)
          )
            throw new Error(
              'Installed publisher does not match the staged Current save capability',
            );
          const current = input.changes.map(({ hash }) => {
            const value = pub.read(tree, `tooltips/${hash}.json`);
            return value === undefined ? null : { value };
          });
          const validated = await planSaveChanges(
            input,
            access,
            current,
            pub.aliasesAt(tree),
            () => ({ value: pin }),
            now,
          );
          if (
            !('conflicts' in validated) &&
            Object.keys(validated.writes).some((path) => globalAggregatePath.test(path)) &&
            hasGlobals(tree)
          )
            throw new HttpError(
              409,
              'Use global entry mutations; Sync pending protection is required',
            );
          plan = validated;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          tree[paths.record(id)] = pub.writeBlob(
            json({ ...outcome, status: 'failed', error: error.message.slice(0, 2000) }),
          );
        }
        if (plan) {
          if ('conflicts' in plan) {
            tree[paths.conflicts(id)] = pub.writeBlob(json(plan));
            tree[paths.record(id)] = pub.writeBlob(json({ ...outcome, status: 'conflicts' }));
          } else {
            const writes = Object.entries(plan.writes);
            if (writes.length) {
              for (const [path, tooltip] of writes) tree[path] = pub.writeBlob(json(tooltip));
              parent = pub.git.commit(
                head,
                tree,
                plan.message,
                requesterCredits(started.requester),
              );
            }
            tree[paths.record(id)] = pub.writeBlob(
              json({ ...outcome, status: 'saved', commit: parent, savedAt: pub.options.now() }),
            );
          }
        }
      }
      try {
        const receipt = pub.git.commit(
          parent,
          tree,
          `Record staged Current save ${id}`,
          appCredits,
        );
        pub.git.cas(ref, head, receipt);
        break;
      } catch (error) {
        if (!(error instanceof RefRace)) throw error;
      }
    }
  }
}
