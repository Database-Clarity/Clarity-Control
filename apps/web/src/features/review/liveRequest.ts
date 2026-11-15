import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';

interface LiveRequest {
  hash: number;
  user: ReturnType<typeof useAuthStore.getState>['user'];
  controller: AbortController;
  pending: ReturnType<typeof getPushedVersion>;
  value: Awaited<ReturnType<typeof getPushedVersion>> | undefined;
}
let active: LiveRequest | undefined;

function request(hash: number): LiveRequest {
  if (
    active?.hash === hash &&
    active.user === useAuthStore.getState().user &&
    !active.controller.signal.aborted
  )
    return active;
  active?.controller.abort();
  const controller = new AbortController();
  const pending = getPushedVersion(hash, controller.signal);
  const result = {
    hash,
    user: useAuthStore.getState().user,
    controller,
    pending,
    value: undefined as Awaited<typeof pending> | undefined,
  };
  active = result;
  // Navigation may be abandoned before a detail component consumes the request.
  void pending.then(
    (value) => {
      result.value = value;
      if (active === result) active = undefined;
    },
    () => {
      if (active === result) active = undefined;
    },
  );
  return result;
}

let staged: ReturnType<typeof request> | undefined;

/** Read an already validated result without starting or consuming a request during render. */
export function preparedReviewLiveValue(hash: number) {
  return staged?.hash === hash &&
    staged.user === useAuthStore.getState().user &&
    !staged.controller.signal.aborted
    ? staged.value
    : undefined;
}

/** Called only by the opened route's loader, never by background code preloading. */
export function startReviewLiveRequest(hash: number, signal: AbortSignal) {
  const next = request(hash);
  if (staged !== next) staged?.controller.abort();
  staged = next;
  const controller = staged.controller;
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return staged.pending;
}

/** A one-use handoff; revisits and retries always request the current live version. */
export function takeReviewLiveRequest(hash: number): ReturnType<typeof request> {
  const next = staged;
  staged = undefined;
  if (
    next?.hash === hash &&
    next.user === useAuthStore.getState().user &&
    !next.controller.signal.aborted
  )
    return next;
  next?.controller.abort();
  return request(hash);
}
