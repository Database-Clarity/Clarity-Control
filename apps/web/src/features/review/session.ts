import { create } from 'zustand';
import { publishableHash } from '@clarity/core';
import { pushSelected } from '../../services/history';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { canPush, type PendingTooltip } from './model';

interface Acknowledgment {
  digest: string;
  previous: string | undefined;
}
interface ReviewSession {
  acknowledgments: Record<string, Acknowledgment>;
  pushing: boolean;
  notice: string | undefined;
  error: string | undefined;
}

// Tab-memory only. Unlike the route, this survives Layout's loading/error gates.
export const useReviewSession = create<ReviewSession>(() => ({
  acknowledgments: {},
  pushing: false,
  notice: undefined,
  error: undefined,
}));
let identityVersion = 0;
useAuthStore.subscribe((state, previous) => {
  if (state.user === previous.user) return;
  identityVersion++;
  useReviewSession.setState({ notice: undefined, error: undefined });
});

export function acknowledgedMarkers(data: EditorData): Record<string, string> {
  const markers = { ...data.bundle.pushed };
  const retained: Record<string, Acknowledgment> = {};
  const { acknowledgments } = useReviewSession.getState();
  for (const [hash, acknowledgment] of Object.entries(acknowledgments)) {
    // Equal = caught up. Different from the pre-push marker = superseding server state.
    // Deleted tooltips also retire the overlay. Never overlay a later authoritative marker.
    if (data.bundle.tooltips[hash] && markers[hash] === acknowledgment.previous) {
      retained[hash] = acknowledgment;
      markers[hash] = acknowledgment.digest;
    }
  }
  if (Object.keys(retained).length !== Object.keys(acknowledgments).length)
    useReviewSession.setState({ acknowledgments: retained });
  return markers;
}

export async function publishReviewed(
  entries: PendingTooltip[],
  data: EditorData,
  isMounted: () => boolean,
): Promise<boolean> {
  const user = useAuthStore.getState().user;
  const version = identityVersion;
  const current = () => version === identityVersion;
  if (
    !canPush(user) ||
    !entries.length ||
    entries.length > 100 ||
    useReviewSession.getState().pushing
  )
    return false;
  useReviewSession.setState({ pushing: true, notice: undefined, error: undefined });
  try {
    const expected = Object.fromEntries(
      await Promise.all(
        entries.map(async ({ tooltip }) => [tooltip.hash, await publishableHash(tooltip)] as const),
      ),
    );
    // Hashing is asynchronous: never submit after leaving the page, changing account/role,
    // or replacing the reviewed saved snapshot. The server also verifies these exact digests.
    if (!isMounted() || !current() || useDataStore.getState().data !== data) return false;
    const result = await pushSelected(
      entries.map(({ tooltip }) => tooltip.hash),
      expected,
    );
    useReviewSession.setState((state) => ({
      acknowledgments: {
        ...state.acknowledgments,
        ...Object.fromEntries(
          Object.entries(result.pushed).map(([hash, digest]) => [
            hash,
            { digest, previous: data.bundle.pushed[hash] },
          ]),
        ),
      },
      ...(current()
        ? {
            notice: `Pushed ${entries.length} tooltip(s) to ${result.branch}. Refreshing saved data.`,
          }
        : {}),
    }));
    // load() reports refresh failures in the data store; they are not failed publishes.
    await useDataStore.getState().load();
    return true;
  } catch (reason) {
    if (current())
      useReviewSession.setState({
        error: `${errorMessage(reason).replace(/[.!?]*$/, '.')} A failed push may have written live data; check the error details before retrying.`,
      });
    return false;
  } finally {
    useReviewSession.setState({ pushing: false });
  }
}
