import { redirect, type LoaderFunctionArgs } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { preparedPending, type PendingTooltip } from './model';
import { acknowledgedMarkers } from './session';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';
import { loadPublished, publishedRows } from './published';

export function initialReviewParams(
  params: URLSearchParams,
  entries: PendingTooltip[],
): URLSearchParams {
  const query = (params.get('query') ?? '').toLowerCase();
  // The list opens on the changes people made; a leftover opens only when the route names it.
  const pool = entries.filter((entry) => !entry.markerOnly);
  const visible = query
    ? pool.filter((entry) =>
        `${entry.name} ${entry.category} ${entry.categoryId} ${entry.tooltip.hash}`
          .toLowerCase()
          .includes(query),
      )
    : pool;
  const requestedHash = params.get('hash');
  const requested =
    requestedHash === null
      ? undefined
      : (visible.find((entry) => String(entry.tooltip.hash) === requestedHash) ??
        entries.find((entry) => entry.markerOnly && String(entry.tooltip.hash) === requestedHash));
  // A kind filter is applied by the page once the words are known; keep a named change meanwhile.
  const selected = requested ?? (params.get('kind') && requestedHash ? undefined : visible[0]);
  const next = new URLSearchParams(params);
  if (selected) next.set('hash', String(selected.tooltip.hash));
  else if (!params.get('kind')) next.delete('hash');
  return next;
}

/** Normalize prepared selection, then start loading the published text of every waiting change. */
export function reviewRoute({ request }: LoaderFunctionArgs) {
  const data = useDataStore.getState().data;
  if (!data) return null;
  const entries = preparedPending(data, acknowledgedMarkers(data));
  if (!entries) return null;
  const url = new URL(request.url);
  const params = url.searchParams;
  const next = initialReviewParams(params, entries);
  // Finish canonical routing before mounting: a post-mount history replacement
  // flushes the newly inserted workspace layout and renders its parent again.
  if (next.toString() !== params.toString())
    return redirect(`/review${next.size ? `?${next}` : ''}`);
  // The Batches subview shows no saved change: nothing to compare.
  if (apiUrl && useAuthStore.getState().user?.role && params.get('view') !== 'batches')
    // Background only: the route commits at once, and rows never wait for these requests.
    void loadPublished(publishedRows(entries));
  return null;
}
