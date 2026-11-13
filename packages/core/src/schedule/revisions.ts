import { approvalInput, type DigestMember } from './digest.js';

export interface Revisions {
  revision: number;
  contentRevision: number;
}

/** Revisions of a newly created batch (its first write; no members yet). */
export const initialRevisions: Revisions = { revision: 1, contentRevision: 0 };

/**
 * Whether a write changes the batch's content: membership (add, remove), any base (rebase), or
 * any non-translation field of a proposal. Exactly when approvedDigest changes, so a scheduled
 * batch's contentRevision and its signed digest can never disagree.
 */
export function isContentChange(
  before: readonly DigestMember[],
  after: readonly DigestMember[],
): boolean {
  return approvalInput(before) !== approvalInput(after);
}

/**
 * Revisions after one write: `revision` +1 on EVERY write; `contentRevision` +1 only on a
 * content change (translation-only saves, renames, and status changes leave it unchanged).
 */
export function nextRevisions(current: Revisions, contentChanged: boolean): Revisions {
  return {
    revision: current.revision + 1,
    contentRevision: current.contentRevision + (contentChanged ? 1 : 0),
  };
}
