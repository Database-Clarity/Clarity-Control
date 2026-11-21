import { batchIdSchema } from '@clarity/core/schedule';
import { HttpError } from '../http.js';
import type { GitHub } from '../github.js';
import type { Identity } from '../types.js';
import { createBatch, listBatches, rebaseBatch, removeFromBatch, saveBatch } from './batches.js';
import { endSchedule, kickBatch, scheduleBatch } from './lifecycle.js';
import { resolveBatch } from './resolve.js';
import { switches } from './store.js';
import {
  admitBatchRequest,
  batchRequestStatus,
  retryBatchRequest,
  endBatchRequest,
  stageScheduledSave,
} from './admission.js';

export const isBatchPath = (path: string) => path === '/batches' || path.startsWith('/batches/');

/** Switch OFF: every /batches route is 503 before authentication (spec I6). */
export function refuseWhenOff(): void {
  if (!switches.scheduled()) throw new HttpError(503, 'Scheduled batches are not enabled');
}

const actions = [
  'save',
  'stage',
  'rebase',
  'remove',
  'schedule',
  'unschedule',
  'cancel',
  'resolve',
  'kick',
  'status',
  'retry',
];

export async function batchesRoute(
  request: Request,
  path: string,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  if (path === '/batches') {
    if (request.method === 'GET') return listBatches(github, user);
    if (request.method === 'POST') return createBatch(request, github, user);
    throw new HttpError(405, 'Method not allowed');
  }
  const match = /^\/batches\/([^/]+)\/([a-z]+)$/.exec(path);
  if (!match || !actions.includes(match[2]!)) throw new HttpError(404, 'Endpoint not found');
  const id = match[1]!;
  if (!batchIdSchema.safeParse(id).success) throw new HttpError(400, 'Invalid batch id');
  if (match[2] === 'status') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return batchRequestStatus(
      github,
      user,
      id,
      new URL(request.url).searchParams.get('requestId') ?? undefined,
    );
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  switch (match[2]) {
    case 'stage':
      return stageScheduledSave(request, github, user, id);
    case 'save':
      if (switches.preparation()) return admitBatchRequest(request, github, user, id, 'save');
      return saveBatch(request, github, user, id);
    case 'rebase':
      return rebaseBatch(request, github, user, id);
    case 'remove':
      return removeFromBatch(request, github, user, id);
    case 'schedule':
      if (switches.preparation()) return admitBatchRequest(request, github, user, id, 'schedule');
      return scheduleBatch(request, github, user, id);
    case 'retry':
      return retryBatchRequest(request, github, user, id);
    case 'unschedule':
      if (switches.preparation()) return endBatchRequest(request, github, user, id, 'unschedule');
      return endSchedule(request, github, user, id, 'unschedule');
    case 'cancel':
      if (switches.preparation()) return endBatchRequest(request, github, user, id, 'cancel');
      return endSchedule(request, github, user, id, 'cancel');
    case 'resolve':
      return resolveBatch(request, github, user, id);
    default:
      return kickBatch(github, user, id);
  }
}
