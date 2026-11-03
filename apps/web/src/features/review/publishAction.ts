import { publishableHash } from '@clarity/core';
import { errorMessage } from '../../services/http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { canPush, type PendingTooltip } from './model';
import { publishDriver } from './publisher';
import { useReviewSession } from './session';

/**
 * Flag-on counterpart of `publishReviewed`: digest what the confirm dialog listed, then hand the
 * set to the publisher, which stores it (stable opId) before anything is sent. Returns as soon as
 * the operation is stored; progress and the result arrive through the publish state. The `pushing`
 * lock only covers hashing and the local write, so the editor stays usable while a run goes live.
 */
export async function queuePublish(
  entries: PendingTooltip[],
  data: EditorData,
  isMounted: () => boolean,
): Promise<boolean> {
  const user = useAuthStore.getState().user;
  const session = useReviewSession.getState();
  if (!canPush(user) || !entries.length || session.pushing) return false;
  useReviewSession.setState({ pushing: true, notice: undefined, error: undefined });
  try {
    const digests = await Promise.all(
      entries.map(
        async ({ tooltip }) =>
          [tooltip.hash, await publishableHash(tooltip, data.aliases)] as const,
      ),
    );
    // Hashing is asynchronous: never submit after leaving the page, changing account/role, or
    // replacing the reviewed snapshot. The server re-verifies these exact digests anyway.
    if (
      !isMounted() ||
      !sameUser(useAuthStore.getState().user, user) ||
      useDataStore.getState().data !== data
    )
      return false;
    await publishDriver.create(
      digests.map(([hash, digest]) => ({
        hash,
        digest,
        previous: data.bundle.pushed[hash],
      })),
    );
    return true;
  } catch (reason) {
    useReviewSession.setState({ error: `${errorMessage(reason).replace(/[.!?]*$/, '.')}` });
    return false;
  } finally {
    useReviewSession.setState({ pushing: false });
  }
}
