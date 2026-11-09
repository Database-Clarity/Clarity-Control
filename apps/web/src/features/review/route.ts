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
  // The list opens on the changes people made; marker-only leftovers only on request, or when the
  // route names one of them.
  const marker = params.get('marker') === '1';
  const pool = entries.filter((entry) => !!entry.markerOnly === marker);
  const visible =
    category || query
      ? pool.filter(
          (entry) =>
            (!category || entry.categoryId === category) &&
            (!query ||
              `${entry.name} ${entry.category} ${entry.categoryId} ${entry.tooltip.hash}`
                .toLowerCase()
                .includes(query)),
        )
      : pool;
  const requestedHash = params.get('hash');
  const requested =
    requestedHash === null
      ? undefined
      : (visible.find((entry) => String(entry.tooltip.hash) === requestedHash) ??
        entries.find((entry) => entry.markerOnly && String(entry.tooltip.hash) === requestedHash));
  const selected = requested ?? visible[0];
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
    // Hand off the comparison without delaying the local route commit. Search
    // input and repeated keyboard moves must never wait for the live API.
    void startReviewLiveRequest(Number(hash), request.signal).catch(() => {});
  }
  if (!request.signal.aborted) beginReviewOpening();
  return null;
}
