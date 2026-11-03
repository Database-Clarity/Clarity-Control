const sessionKey = 'clarity-editor-session';
const logoutKey = 'clarity-editor-signout';
const preferenceKey = 'clarity-editor-remember-signin';
const pendingKey = 'clarity-editor-signin-pending';
const changed = 'clarity-session-changed';
// Matches the Worker's OAuth state lifetime.
const pendingWindowMs = 10 * 60 * 1000;

/**
 * Called when this browser starts sign-in. Besides the remember-me choice it records a random
 * one-time marker in this tab's sessionStorage (it survives the GitHub round trip), so
 * #/auth/callback is only honoured when this tab asked for it. A forged link cannot set it.
 */
export function rememberSignIn(remember: boolean): void {
  sessionStorage.setItem(preferenceKey, String(remember));
  sessionStorage.setItem(pendingKey, `${Date.now()}.${crypto.randomUUID()}`);
}

/** One-time check for a sign-in this tab started. Always clears the marker; touches no session. */
export function consumePendingSignIn(): boolean {
  let marker: string | null = null;
  try {
    marker = sessionStorage.getItem(pendingKey);
    sessionStorage.removeItem(pendingKey);
  } catch {
    return false;
  }
  const started = Number(marker?.split('.')[0]);
  return (
    Number.isFinite(started) && started <= Date.now() && Date.now() - started <= pendingWindowMs
  );
}

// The Worker signs payload.signature tokens with a fixed 30-day expiry.
// Decoding exp only controls client cleanup; the Worker still verifies the signature.
function expires(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function setSession(
  token: string,
  remember = sessionStorage.getItem(preferenceKey) === 'true',
): void {
  if (!token || token.length > 8192 || expires(token) <= Date.now())
    throw new Error('Invalid or expired session');
  const target = remember ? localStorage : sessionStorage;
  target.setItem(sessionKey, token);
  (remember ? sessionStorage : localStorage).removeItem(sessionKey);
  sessionStorage.removeItem(preferenceKey);
}

export function clearSession(): void {
  sessionStorage.removeItem(sessionKey);
  localStorage.removeItem(sessionKey);
  // A separate signal also signs out tabs that have a per-tab session.
  localStorage.setItem(logoutKey, crypto.randomUUID());
}

export function sessionToken(): string | null {
  const token = sessionStorage.getItem(sessionKey) ?? localStorage.getItem(sessionKey);
  if (token && expires(token) <= Date.now()) {
    clearSession();
    window.dispatchEvent(new Event(changed));
    return null;
  }
  return token;
}

export function subscribeSession(reload: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key === logoutKey || event.key === null) sessionStorage.removeItem(sessionKey);
    if (event.key === sessionKey || event.key === logoutKey || event.key === null) reload();
  };
  window.addEventListener('storage', storage);
  window.addEventListener(changed, reload);
  // Also expire an idle open tab without waiting for its next API request.
  const timer = window.setInterval(() => {
    try {
      sessionToken();
    } catch {
      // Storage can become unavailable in a background tab. The next explicit
      // auth request surfaces that failure through the existing login error UI.
    }
  }, 1000);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(changed, reload);
    window.clearInterval(timer);
  };
}
