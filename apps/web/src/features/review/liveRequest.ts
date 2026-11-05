import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';

function request(hash: number) {
  const controller = new AbortController();
  const pending = getPushedVersion(hash, controller.signal);
  const result = {
    hash,
    user: useAuthStore.getState().user,
    controller,
    pending,
    value: undefined as Awaited<typeof pending> | undefined,
  };
  // Navigation may be abandoned before a detail component consumes the request.
  void pending.then(
    (value) => {
      result.value = value;
    },
    () => {},
  );
  return result;
}

let staged: ReturnType<typeof request> | undefined;
let redirectHandoff:
  { value: ReturnType<typeof request>; timer: ReturnType<typeof setTimeout> } | undefined;

function clearRedirectHandoff() {
  if (redirectHandoff) clearTimeout(redirectHandoff.timer);
  redirectHandoff = undefined;
}

function replaceStaged(hash: number) {
  clearRedirectHandoff();
  staged?.controller.abort();
  staged = request(hash);
  return staged;
}

/** Start on open while the router normalizes the URL, not during code preloading. */
export function stageReviewRedirectLiveRequest(hash: number): void {
  const value = replaceStaged(hash);
  // Only this redirect turn may claim the request. Abandoned redirects cannot
  // leave a response cached for a later visit, even if their signal never aborts.
  const timer = setTimeout(() => {
    if (redirectHandoff?.value !== value) return;
    redirectHandoff = undefined;
    if (staged === value) staged = undefined;
    value.controller.abort();
  }, 0);
  redirectHandoff = { value, timer };
}

/** Read an already validated result without starting or consuming a request during render. */
export function preparedReviewLiveValue(hash: number) {
  return staged?.hash === hash &&
    staged.user === useAuthStore.getState().user &&
    !staged.controller.signal.aborted
    ? staged.value
    : undefined;
}

/** Called only by the opened route's loader, never by background code preloading. */
export function startReviewLiveRequest(hash: number, signal: AbortSignal): void {
  if (
    staged &&
    redirectHandoff?.value === staged &&
    staged.hash === hash &&
    staged.user === useAuthStore.getState().user &&
    !staged.controller.signal.aborted
  )
    clearRedirectHandoff();
  else replaceStaged(hash);
  if (!staged) return;
  const controller = staged.controller;
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
}

/** A one-use handoff; revisits and retries always request the current live version. */
export function takeReviewLiveRequest(hash: number): ReturnType<typeof request> {
  clearRedirectHandoff();
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
