const sessionKey = 'clarity-editor-session';
const logoutKey = 'clarity-editor-signout';
const preferenceKey = 'clarity-editor-remember-signin';
const changed = 'clarity-session-changed';

export function rememberSignIn(remember: boolean): void {
  sessionStorage.setItem(preferenceKey, String(remember));
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
  // Expiry belongs to the entry inspected, not to every tab's session.
  for (const storage of [sessionStorage, localStorage]) {
    const token = storage.getItem(sessionKey);
    if (!token) continue;
    if (expires(token) > Date.now()) return token;
    if (storage.getItem(sessionKey) === token) storage.removeItem(sessionKey);
    window.dispatchEvent(new Event(changed));
  }
  return null;
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
