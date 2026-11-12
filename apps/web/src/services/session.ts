const sessionKey = 'clarity-editor-session';
const logoutKey = 'clarity-editor-signout';
const preferenceKey = 'clarity-editor-remember-signin';
const pendingKey = 'clarity-editor-signin-pending';
const changed = 'clarity-session-changed';
// Matches the Worker's OAuth state lifetime.
const pendingWindowMs = 10 * 60 * 1000;

const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Prepare an actual link, including modifier-click and context-menu navigation to a new tab. */
export function rememberSignIn(remember: boolean): string {
  const now = Date.now();
  const pending: { key: string; at: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(`${pendingKey}:`)) continue;
    let at = 0;
    try {
      at = JSON.parse(localStorage.getItem(key) ?? '').at;
    } catch {
      /* prune invalid entries */
    }
    pending.push({ key, at });
  }
  pending.sort((a, b) => b.at - a.at);
  for (const [index, entry] of pending.entries()) {
    if (
      !Number.isFinite(entry.at) ||
      entry.at > now ||
      now - entry.at > pendingWindowMs ||
      index >= 31
    )
      localStorage.removeItem(entry.key);
  }
  const nonce = crypto.randomUUID();
  localStorage.setItem(`${pendingKey}:${nonce}`, JSON.stringify({ at: now, remember }));
  sessionStorage.setItem(preferenceKey, String(remember));
  return nonce;
}

/** Exact, expiring, one-time browser binding; unrelated pending sign-ins confer no authority. */
export function consumePendingSignIn(nonce: string | null): boolean {
  if (!nonce || nonce.length !== 36 || !noncePattern.test(nonce)) return false;
  try {
    const key = `${pendingKey}:${nonce}`;
    const marker = localStorage.getItem(key);
    localStorage.removeItem(key);
    if (!marker) return false;
    const { at, remember } = JSON.parse(marker);
    const now = Date.now();
    if (
      !Number.isFinite(at) ||
      at > now ||
      now - at > pendingWindowMs ||
      typeof remember !== 'boolean'
    )
      return false;
    // The callback may be in a different tab; carry its own remember-me choice with the nonce.
    sessionStorage.setItem(preferenceKey, String(remember));
    return true;
  } catch {
    return false;
  }
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

/** The server rejected this token: drop only entries holding it; no global sign-out signal. */
export function dropRejectedSession(token: string): void {
  for (const storage of [sessionStorage, localStorage])
    if (storage.getItem(sessionKey) === token) storage.removeItem(sessionKey);
  window.dispatchEvent(new Event(changed));
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
