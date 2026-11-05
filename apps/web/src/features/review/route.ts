import {
  redirect,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from 'react-router-dom';
import { useDataStore, type EditorData } from '../../stores/data';
import { preparedPending, type PendingTooltip } from './model';
import { acknowledgedMarkers } from './session';
import { startReviewLiveRequest } from './liveRequest';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';

let implicitOpening:
  | {
      data: EditorData;
      user: ReturnType<typeof useAuthStore.getState>['user'];
      hash: string;
      signal: AbortSignal;
    }
  | undefined;

/** Canonicalizing the default selection completes this same open, not a new live comparison. */
export function shouldRevalidateReview({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const opening = implicitOpening;
  if (
    opening &&
    !opening.signal.aborted &&
    !formMethod &&
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.pathname.endsWith('/review') &&
    currentUrl.searchParams.size === 0 &&
    nextUrl.searchParams.size === 1 &&
    nextUrl.searchParams.get('hash') === opening.hash &&
    opening.data === useDataStore.getState().data &&
    opening.user === useAuthStore.getState().user
  ) {
    implicitOpening = undefined;
    return false;
  }
  return defaultShouldRevalidate;
}

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

/** Normalize prepared selection, then start the selected live comparison on open. */
export async function reviewRoute({ request }: LoaderFunctionArgs) {
  implicitOpening = undefined;
  const data = useDataStore.getState().data;
  if (!data) return null;
  const entries = preparedPending(data, acknowledgedMarkers(data));
  if (!entries) return null;
  const url = new URL(request.url);
  const params = url.searchParams;
  const next = initialReviewParams(params, entries);
  const implicit = params.size === 0 && url.pathname.endsWith('/review');
  if (!implicit && next.toString() !== params.toString())
    return redirect(`/review${next.size ? `?${next}` : ''}`);
  const hash = next.get('hash');
  const user = useAuthStore.getState().user;
  if (hash && apiUrl && user?.role) {
    // Mount the selected comparison with its validated live value in the first
    // render, rather than painting a loading detail and replacing it next frame.
    // The detail consumes this same promise and presents failures with Retry.
    await startReviewLiveRequest(Number(hash), request.signal).catch(() => {});
  }
  // The page's existing replace effect writes this default hash. Avoid an
  // extra redirect/navigation before mounting and a duplicate GET afterward.
  if (implicit && hash && !request.signal.aborted)
    implicitOpening = { data, user, hash, signal: request.signal };
  return null;
}
