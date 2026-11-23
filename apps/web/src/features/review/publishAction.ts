import { inactivePublishableHash } from '@clarity/core';
import { globalsEnabled } from '../../services/globalsFlag';
import { errorMessage } from '../../services/http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { canPush, type PendingTooltip } from './model';
import { publishDependencies } from './publishDependencies';
import type { PublishInput } from './publishDriver';
import { publishDriver } from './publisher';
import { useReviewSession } from './session';

export function planReviewedPublish(
  entries: PendingTooltip[],
  pending: PendingTooltip[],
  data: EditorData,
) {
  const { bundle, aliases } = data;
  const pendingByHash = new Map(
    pending.filter((entry) => !entry.markerOnly).map((entry) => [entry.tooltip.hash, entry]),
  );
  const dependencies = publishDependencies(
    bundle.tooltips,
    aliases,
    new Set(pendingByHash.keys()),
    entries.map((entry) => entry.tooltip),
    bundle.inactiveMoves,
    globalsEnabled,
  );
  const missing = new Set([...dependencies.values()].flat());
  for (const { tooltip } of entries) missing.delete(tooltip.hash);
  if (missing.size) {
    const names = [...missing].map((hash) => pendingByHash.get(hash)!.name);
    throw new Error(`Include ${new Intl.ListFormat('en').format(names)} before publishing.`);
  }
  return entries.map(({ tooltip }) => ({
    tooltip,
    hash: tooltip.hash,
    previous: bundle.pushed[tooltip.hash],
    dependencies: dependencies.get(tooltip.hash),
  }));
}

/**
 * Flag-on counterpart of `publishReviewed`: digest what the confirm dialog listed, then hand the
 * set to the publisher, which stores it (stable opId) before anything is sent. Returns as soon as
 * the operation is stored; progress and the result arrive through the publish state. The `pushing`
 * lock only covers hashing and the local write, so the editor stays usable while a run goes live.
 */
export async function queuePublish(
  inputs: ReturnType<typeof planReviewedPublish>,
  data: EditorData,
  isMounted: () => boolean,
): Promise<boolean> {
  const user = useAuthStore.getState().user;
  const session = useReviewSession.getState();
  if (!canPush(user) || !inputs.length || session.pushing) return false;
  useReviewSession.setState({ pushing: true, notice: undefined, error: undefined });
  try {
    const reviewed: PublishInput[] = await Promise.all(
      inputs.map(async ({ tooltip, ...input }) => ({
        ...input,
        digest: await inactivePublishableHash(tooltip, data.aliases, data.bundle.inactiveMoves),
      })),
    );
    // Hashing is asynchronous: never submit after leaving the page, changing account/role, or
    // replacing the reviewed snapshot. The server re-verifies these exact digests anyway.
    if (
      !isMounted() ||
      !sameUser(useAuthStore.getState().user, user) ||
      useDataStore.getState().data !== data
    )
      return false;
    await publishDriver.create(reviewed);
    return true;
  } catch (reason) {
    useReviewSession.setState({ error: `${errorMessage(reason).replace(/[.!?]*$/, '.')}` });
    return false;
  } finally {
    useReviewSession.setState({ pushing: false });
  }
}
