import { HttpError } from '../http.js';

/** Raw aggregates, imports, history/reverts, and unsupported batches must use S2/S4 instead.
 * This is deliberately fail-closed; S5 owns installing it in every generic writer.
 */
export function assertNoRawGlobalMutation(hashes: readonly number[]): void {
  if (hashes.includes(1) || hashes.includes(2) || hashes.includes(3))
    throw new HttpError(409, 'Use global entry mutations; Sync pending protection is required');
}
