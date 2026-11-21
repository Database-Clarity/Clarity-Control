import {
  currentSaveIntent,
  currentSaveStageInput,
  currentSaveStagePaths as paths,
  currentSaveStageRecord,
  currentSaveStagingCapability,
  permissionsSchema,
  publishOpIdSchema,
  stableStringify,
  validatePublishTime,
  type CurrentSaveStageRecord,
} from '@clarity/core';
import { exporter, publisherPinPath } from './elementTags.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import { signingKey } from './publish.js';
import { currentSaveRoles } from './save.js';
import type { Identity } from './types.js';

async function snapshot(github: GitHub, user: Identity, id: string) {
  const state = await github.publishSnapshot([
    'config/permissions.json',
    publisherPinPath,
    paths.record(id),
  ]);
  const [permissions, pin, stored] = state.files;
  if (!permissions) throw new HttpError(502, 'Missing repository file: config/permissions.json');
  requireAccess(permissionsSchema.parse(permissions.value), user, currentSaveRoles);
  const record = stored ? currentSaveStageRecord.parse(stored.value) : null;
  if (record && record.requester.id !== user.id)
    throw new HttpError(404, 'Save request was not found');
  const capabilities = (pin?.value as { capabilities?: unknown } | undefined)?.capabilities;
  return {
    ...state,
    record,
    supported: Array.isArray(capabilities) && capabilities.includes(currentSaveStagingCapability),
  };
}

export async function stageCurrentSave(request: Request, github: GitHub, user: Identity) {
  if (request.method === 'GET') {
    const id = publishOpIdSchema.safeParse(new URL(request.url).searchParams.get('requestId'));
    if (!id.success) throw new HttpError(400, 'Invalid save request identifier');
    const { head, record } = await snapshot(github, user, id.data);
    if (!record || record.status === 'uploading')
      throw new HttpError(404, 'Save request was not found');
    if (record.status === 'saved')
      return json({ status: record.status, commit: record.commit, savedAt: record.savedAt });
    if (record.status === 'conflicts') return json({ status: record.status, head });
    if (record.status === 'failed') return json({ status: record.status, error: record.error });
    return json({ status: record.status });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!exporter.publisherEnabled()) throw new HttpError(503, 'Publisher is not enabled');
  const input = await body(request, currentSaveStageInput, 48 * 1024);
  const id = input.requestId;
  const requester = { id: user.id, login: user.login };
  try {
    validatePublishTime(id, Date.now());
  } catch {
    throw new HttpError(400, 'This save attempt expired. Retry from your drafts.');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await snapshot(github, user, id);
    if (!state.supported)
      throw new HttpError(422, 'Update the installed publisher before landing these edits');
    const record = state.record;
    if (record && record.status !== 'uploading')
      throw new HttpError(409, 'This save was already queued');
    const updatedAt = new Date().toISOString();
    let next: CurrentSaveStageRecord;
    const files: Record<string, unknown> = {};
    if ('part' in input) {
      if (input.part !== (record?.parts ?? 0))
        throw new HttpError(409, 'Save parts arrived out of order. Retry from your drafts.');
      next = { status: 'uploading', parts: input.part + 1, requester, updatedAt };
      files[paths.part(id, input.part)] = input.content;
    } else {
      if (!record || record.parts !== input.parts)
        throw new HttpError(409, 'Save parts are missing. Retry from your drafts.');
      const intent = currentSaveIntent.parse({
        version: 1,
        requestId: id,
        requester,
        repo: `${github.env.GITHUB_OWNER}/${github.env.GITHUB_REPO}`,
        branch: github.env.DATA_BRANCH,
        sourceCommit: state.head,
        parts: input.parts,
        digest: input.digest,
      });
      const payload = stableStringify(intent);
      const signature = await crypto.subtle.sign(
        'Ed25519',
        (await signingKey(github.env)).key,
        new TextEncoder().encode(payload),
      );
      next = {
        status: 'queued',
        parts: input.parts,
        requester,
        updatedAt,
        envelope: { payload, sig: btoa(String.fromCharCode(...new Uint8Array(signature))) },
      };
      files[paths.kick(id)] = { requestId: id };
    }
    files[paths.record(id)] = next;
    try {
      await github.commit(
        state.head,
        files,
        'part' in input ? 'Stage Current save part' : 'Queue Current save',
        user,
        { baseTree: state.tree },
      );
      return 'part' in input ? json({ accepted: input.part }) : json({ queued: true }, 202);
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving. Retry from your drafts.');
}
