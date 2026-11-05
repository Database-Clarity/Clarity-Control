import { redirect, type LoaderFunctionArgs } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { preparedPending, type PendingTooltip } from './model';
import { acknowledgedMarkers } from './session';
import { startReviewLiveRequest } from './liveRequest';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';
import { beginReviewOpening } from './opening';

export function initialReviewParams(
  params: URLSearchParams,
  entries: PendingTooltip[],
): URLSearchParams {
  const category = params.get('category') ?? '';
  const query = (params.get('query') ?? '').toLowerCase();
  const visible =
    category || query
      ? entries.filter(
          (entry) =>
            (!category || entry.categoryId === category) &&
            (!query ||
              `${entry.name} ${entry.category} ${entry.categoryId} ${entry.tooltip.hash}`
                .toLowerCase()
                .includes(query)),
        )
      : entries;
  const requestedHash = params.get('hash');
  const selected =
    (requestedHash === null
      ? undefined
      : visible.find((entry) => String(entry.tooltip.hash) === requestedHash)) ?? visible[0];
  const next = new URLSearchParams(params);
  if (selected) next.set('hash', String(selected.tooltip.hash));
  else next.delete('hash');
  return next;
}

/** Normalize prepared selection, then start the selected live comparison on open. */
export async function reviewRoute({ request }: LoaderFunctionArgs) {
  const data = useDataStore.getState().data;
  if (!data) return null;
  const entries = preparedPending(data, acknowledgedMarkers(data));
  if (!entries) {
    if (!request.signal.aborted) beginReviewOpening(false);
    return null;
  }
  const url = new URL(request.url);
  const params = url.searchParams;
  const next = initialReviewParams(params, entries);
  // Finish canonical routing before mounting: a post-mount history replacement
  // flushes the newly inserted workspace layout and renders its parent again.
  if (next.toString() !== params.toString())
    return redirect(`/review${next.size ? `?${next}` : ''}`);
  const hash = next.get('hash');
  if (hash && apiUrl && useAuthStore.getState().user?.role) {
    // Mount the selected comparison with its validated live value in the first
    // render, rather than painting a loading detail and replacing it next frame.
    // The detail consumes this same promise and presents failures with Retry.
    await startReviewLiveRequest(Number(hash), request.signal).catch(() => {});
  }
  if (!request.signal.aborted) beginReviewOpening();
  return null;
}
