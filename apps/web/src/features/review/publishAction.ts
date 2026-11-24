import { inactivePublishableHash, isMovedInactive, type Tooltip } from '@clarity/core';
import { errorMessage } from '../../services/http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { neededGlobals } from './globalsPending';
import { canPush, type PendingTooltip } from './model';
import { publishDependencies } from './publishDependencies';
import {
  activeGlobals,
  activeHashes,
  publishChunks,
  PublishClosureLimitError,
  publishingAlready,
  usePublishState,
  type PublishInput,
} from './publishDriver';
import { publishedFor, usePublished } from './published';
import { publishDriver } from './publisher';
import { useReviewSession } from './session';

/** The chosen rows, and the new globals they use: those publish along or hold the rows back. */
export function withNeededGlobals(
  chosen: PendingTooltip[],
  pending: PendingTooltip[],
  inFlight: ReadonlySet<number>,
  data: EditorData,
) {
  const needed = neededGlobals(chosen, pending, data);
  for (const { global, by } of needed) {
    if (global.unpublishable)
      throw new Error(
        `${by.name} uses the new global ${global.name}, which can't be published yet. ${global.unpublishable}`,
      );
    if (inFlight.has(global.tooltip.hash))
      throw new Error(
        `${by.name} uses the new global ${global.name}, which is being published. Publish it once that is live.`,
      );
  }
  return {
    picked: [...chosen, ...needed.map(({ global }) => global)],
    needed: new Map(needed.map(({ global, by }) => [global, by.name])),
  };
}

/** The chosen tooltips' requests; globals join the first (`queuePublish`). */
export function planReviewedPublish(
  chosen: PendingTooltip[],
  pending: PendingTooltip[],
  data: EditorData,
) {
  const entries = chosen.filter(({ part }) => !part?.pending);
  const { bundle, aliases } = data;
  const byHash = usePublished.getState().byHash;
  const pendingByHash = new Map(
    pending
      .filter((entry) => !entry.markerOnly && !entry.part?.pending)
      .map((entry) => [entry.tooltip.hash, entry]),
  );
  const inputs = entries.map(({ tooltip, inactiveChange, inactiveAliases }) => ({
    tooltip,
    hash: tooltip.hash,
    previous: bundle.pushed[tooltip.hash],
    consumers: inactiveChange === 'remove' ? 1 : Object.keys(tooltip.text).length,
    removal:
      inactiveChange === 'remove' ||
      inactiveAliases?.some((hash) => isMovedInactive(hash, bundle.inactiveMoves)),
  }));
  const published: Record<number, Tooltip | null | undefined> = {};
  if (inputs.some(({ removal }) => removal)) {
    const versions = entries.map(({ tooltip, pushed, inactiveChange }) => ({
      hash: tooltip.hash,
      pushed,
      // A canonical removal marker records absence even when the archive retains old text.
      version:
        inactiveChange === 'restore'
          ? { status: 'ready' as const, tooltip: null }
          : publishedFor(byHash, tooltip.hash, pushed),
    }));
    if (versions.some(({ version }) => version?.status === 'missing'))
      throw new Error('Some selected changes need published versions that could not be recovered.');
    if (versions.some(({ version }) => version?.status === 'error'))
      throw new Error('Refresh Review to retry loading the published versions.');
    if (versions.some(({ version }) => version?.status !== 'ready'))
      throw new Error('Wait for the published versions to load, then publish again.');
    for (const { hash, pushed, version } of versions)
      if (version?.status === 'ready')
        published[hash] = pushed === undefined ? undefined : version.tooltip;
  }
  const dependencies = publishDependencies(
    bundle.tooltips,
    aliases,
    new Set(pendingByHash.keys()),
    entries.map((entry) => entry.tooltip),
    { moves: bundle.inactiveMoves, published },
  );
  const missing = new Set([...dependencies.values()].flat());
  for (const { tooltip } of entries) missing.delete(tooltip.hash);
  if (missing.size) {
    const names = [...missing].map((hash) => pendingByHash.get(hash)!.name);
    throw new Error(`Include ${new Intl.ListFormat('en').format(names)} before publishing.`);
  }
  const planned = inputs.map((input) => ({
    ...input,
    dependencies: dependencies.get(input.hash),
  }));
  try {
    publishChunks(planned);
  } catch (reason) {
    if (reason instanceof PublishClosureLimitError) {
      const names = new Map(entries.map(({ tooltip, name }) => [tooltip.hash, name]));
      const format = new Intl.ListFormat('en');
      const groups = reason.groups.map(
        ({ hashes, consumers }) =>
          `A group requiring ${consumers} tooltip languages includes ${format.format(
            hashes.map((hash) => names.get(hash) ?? `Tooltip ${hash}`),
          )}.`,
      );
      throw new Error(`${reason.message} ${groups.join(' ')}`);
    }
    throw reason;
  }
  return planned;
}

/**
 * Flag-on counterpart of `publishReviewed`: digest what the confirm dialog listed, then hand the
 * set to the publisher, which stores it (stable opId) before anything is sent. Returns as soon as
 * the operation is stored; progress and the result arrive through the publish state. The `pushing`
 * lock only covers hashing and the local write, so the editor stays usable while a run goes live.
 */
export async function queuePublish(
  inputs: ReturnType<typeof planReviewedPublish>,
  chosen: readonly PendingTooltip[],
  data: EditorData,
  isMounted: () => boolean,
): Promise<boolean> {
  const user = useAuthStore.getState().user;
  const session = useReviewSession.getState();
  const globals = chosen.flatMap(({ part }) =>
    part?.pending ? [{ id: part.pending.id, expected: part.pending.digest, name: part.name }] : [],
  );
  if (!canPush(user) || !(inputs.length || globals.length) || session.pushing) return false;
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
    // A confirmation can outlive the rows it listed: another publish may hold them by now.
    const { ops } = usePublishState.getState();
    const held = activeHashes(ops);
    const heldGlobals = activeGlobals(ops);
    if (
      reviewed.some(({ hash }) => held.has(hash)) ||
      globals.some(({ id }) => heldGlobals.has(id))
    )
      throw new Error(publishingAlready);
    await publishDriver.create(reviewed, globals, !!data.bundle.globalsPending);
    return true;
  } catch (reason) {
    useReviewSession.setState({ error: `${errorMessage(reason).replace(/[.!?]*$/, '.')}` });
    return false;
  } finally {
    useReviewSession.setState({ pushing: false });
  }
}
