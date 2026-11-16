import { HttpError } from '../http.js';
import {
  publicationSchema,
  sameSources,
  sourcesSchema,
  syncSchema,
  type Sources,
} from './model.js';

/** S5 calls this for EACH destination/consumer at admission AND final CAS/drain.
 * A current complete proof is required even when pending is empty; absence is not independence.
 * The caller observes current source identities again at the publishing CAS boundary.
 */
export function assertGlobalsPublication(
  sources: Sources,
  syncInput: unknown,
  certificate: unknown,
  consumer: { hash: number; lang: string; destination: string },
): void {
  const observed = sourcesSchema.safeParse(sources);
  const sync = syncSchema.safeParse(syncInput);
  const proof = publicationSchema.safeParse(certificate);
  if (
    !observed.success ||
    !sync.success ||
    !proof.success ||
    !sameSources(proof.data.sources, observed.data) ||
    proof.data.consumer.hash !== consumer.hash ||
    proof.data.consumer.lang !== consumer.lang ||
    proof.data.consumer.destination !== consumer.destination ||
    proof.data.causeIds.length !== sync.data.causeIds.length ||
    !sync.data.causeIds.every((id) => proof.data.causeIds.includes(id)) ||
    (sync.data.status !== 'current' && !proof.data.independent)
  )
    throw new HttpError(409, 'Sync pending: current complete publication proof required');
}

/** Raw aggregates, imports, history/reverts, and unsupported batches must use S2/S4 instead.
 * This is deliberately fail-closed; S5 owns installing it in every generic writer.
 */
export function assertNoRawGlobalMutation(hashes: readonly number[]): void {
  if (hashes.includes(2) || hashes.includes(3))
    throw new HttpError(409, 'Use global entry mutations; Sync pending protection is required');
}
