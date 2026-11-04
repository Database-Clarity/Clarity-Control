import { redirect, type LoaderFunctionArgs } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { preparedPending, type PendingTooltip } from './model';
import { acknowledgedMarkers } from './session';

export function initialReviewParams(
  params: URLSearchParams,
  entries: PendingTooltip[],
): URLSearchParams {
  const category = params.get('category') ?? '';
  const query = (params.get('query') ?? '').toLowerCase();
  const visible = entries.filter(
    (entry) =>
      (!category || entry.categoryId === category) &&
      (!query ||
        `${entry.name} ${entry.category} ${entry.categoryId} ${entry.tooltip.hash}`
          .toLowerCase()
          .includes(query)),
  );
  const selected =
    visible.find((entry) => String(entry.tooltip.hash) === params.get('hash')) ?? visible[0];
  const next = new URLSearchParams(params);
  if (selected) next.set('hash', String(selected.tooltip.hash));
  else next.delete('hash');
  return next;
}

/** Normalize an already prepared selection before mounting; never wait for or load data. */
export function reviewRoute({ request }: LoaderFunctionArgs) {
  const data = useDataStore.getState().data;
  if (!data) return null;
  const entries = preparedPending(data, acknowledgedMarkers(data));
  if (!entries) return null;
  const params = new URL(request.url).searchParams;
  const next = initialReviewParams(params, entries);
  return next.toString() === params.toString()
    ? null
    : redirect(`/review${next.size ? `?${next}` : ''}`);
}
