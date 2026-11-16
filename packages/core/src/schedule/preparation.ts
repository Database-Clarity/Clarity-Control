import type { Batch } from './schemas.js';
import type { ScheduleRequest } from './intent.js';

/** The materializer must check this again at its output CAS head, including on failure. */
export function matchesPreparationFence(batch: Batch, request: ScheduleRequest): boolean {
  return (
    batch.id === request.batchId &&
    batch.status === 'preparing' &&
    batch.claim === null &&
    batch.preparedRequestId == null &&
    batch.preparation?.requestId === request.requestId &&
    batch.preparation.attempt === request.attempt &&
    request.status === 'pending' &&
    batch.revision === request.admissionRevision
  );
}

/** New publication envelopes must carry the SAME prepared request ID; legacy admission is separate. */
export function canClaimPreparedBatch(batch: Batch, preparedRequestId: string): boolean {
  return (
    batch.status === 'scheduled' &&
    batch.claim === null &&
    !batch.preparation &&
    batch.preparedRequestId === preparedRequestId &&
    batch.opId !== null &&
    batch.scheduledContentRevision === batch.contentRevision
  );
}
