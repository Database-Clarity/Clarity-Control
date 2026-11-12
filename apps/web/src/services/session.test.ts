// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearSession,
  consumePendingSignIn,
  dropRejectedSession,
  rememberSignIn,
  sessionToken,
  setSession,
  subscribeSession,
} from './session';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { completeCallback } from '../features/auth/AuthCallback';
const key = 'clarity-editor-session';
const token = () =>
  btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })) + '.signature';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('defaults to per-tab storage and preserves reloads in that tab', () => {
  const value = token();
  setSession(value);
  expect(localStorage.getItem(key)).toBeNull();
  expect(sessionToken()).toBe(value);
  sessionStorage.clear(); // A new tab has independent sessionStorage.
  expect(sessionToken()).toBeNull();
});
it('carries the checkbox preference through OAuth and remembers across new tabs', () => {
  rememberSignIn(true);
  const value = token();
  setSession(value);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(sessionToken()).toBe(value);
  sessionStorage.clear();
  expect(sessionToken()).toBe(value);
});
it('sign-out clears both stores and signals even when only per-tab tokens exist', () => {
  setSession(token());
  clearSession();
  expect(sessionToken()).toBeNull();
  expect(localStorage.getItem('clarity-editor-signout')).toBeTruthy();
  setSession(token(), true);
  clearSession();
  expect(localStorage.getItem(key)).toBeNull();
});
it('signs another tab out and reloads its user on the storage signal', () => {
  setSession(token());
  const reload = vi.fn();
  const stop = subscribeSession(reload);
  const event = new StorageEvent('storage', { key: 'clarity-editor-signout', newValue: 'signal' });
  Object.defineProperty(event, 'storageArea', { value: localStorage });
  window.dispatchEvent(event);
  expect(sessionToken()).toBeNull();
  expect(reload).toHaveBeenCalledOnce();
  stop();
});
it('expires an idle remembered session and informs the auth UI', () => {
  vi.useFakeTimers();
  setSession(token(), true);
  const reload = vi.fn();
  const stop = subscribeSession(reload);
  vi.advanceTimersByTime(61000);
  expect(sessionToken()).toBeNull();
  expect(reload).toHaveBeenCalledOnce();
  stop();
});
it('rejects expired or malformed tokens without persisting them', () => {
  expect(() => setSession('invalid')).toThrow('expired');
  expect(() => setSession(btoa(JSON.stringify({ exp: 1 })) + '.sig', true)).toThrow('expired');
  expect(sessionToken()).toBeNull();
});
it('accepts only the exact nonce once, including a callback opened in another tab', () => {
  const nonce = rememberSignIn(true);
  sessionStorage.clear(); // Tab B shares localStorage, but not sessionStorage with tab A.
  expect(consumePendingSignIn(null)).toBe(false);
  expect(consumePendingSignIn(crypto.randomUUID())).toBe(false);
  expect(consumePendingSignIn(nonce)).toBe(true);
  expect(consumePendingSignIn(nonce)).toBe(false);
  const value = token();
  setSession(value);
  expect(localStorage.getItem(key)).toBe(value);
});
it('an abandoned sign-in does not authorize an attacker callback or a foreign-origin nonce', () => {
  const abandoned = rememberSignIn(false);
  const attacker = crypto.randomUUID(); // Generated in a different origin's storage.
  const existing = token();
  setSession(existing, true);
  expect(consumePendingSignIn(attacker)).toBe(false);
  expect(consumePendingSignIn(null)).toBe(false);
  expect(sessionToken()).toBe(existing);
  expect(consumePendingSignIn(abandoned)).toBe(true);
});
it('expires pending sign-ins, rejects future and malformed entries, and prunes storage', () => {
  vi.useFakeTimers();
  const expired = rememberSignIn(true);
  vi.advanceTimersByTime(10 * 60 * 1000 + 1);
  expect(consumePendingSignIn(expired)).toBe(false);
  const nonce = crypto.randomUUID();
  const pendingKey = `clarity-editor-signin-pending:${nonce}`;
  for (const marker of ['garbage', JSON.stringify({ at: Date.now() + 1, remember: true })]) {
    localStorage.setItem(pendingKey, marker);
    expect(consumePendingSignIn(nonce)).toBe(false);
  }
  for (let i = 0; i < 40; i++) rememberSignIn(false);
  expect(localStorage.length).toBeLessThanOrEqual(32);
  vi.advanceTimersByTime(10 * 60 * 1000 + 1);
  rememberSignIn(false);
  expect(localStorage.length).toBe(1);
});
it('fails closed when nonce storage is unavailable', () => {
  const nonce = rememberSignIn(false);
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('storage');
  });
  expect(consumePendingSignIn(nonce)).toBe(false);
});

it('expires an older per-tab token without deleting or signing out a newer remembered session', () => {
  vi.useFakeTimers();
  setSession(token()); // Tab A, without Remember me.
  vi.advanceTimersByTime(30000);
  const newer = token();
  localStorage.setItem(key, newer); // Tab B, with Remember me; A retains its per-tab token.
  const reload = vi.fn();
  const stop = subscribeSession(reload);
  vi.advanceTimersByTime(31000);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem(key)).toBe(newer);
  expect(localStorage.getItem('clarity-editor-signout')).toBeNull();
  expect(sessionToken()).toBe(newer);
  expect(reload).toHaveBeenCalledOnce();
  stop();
});

it('removes an expired shared entry without broadcasting global logout', () => {
  vi.useFakeTimers();
  setSession(token(), true);
  vi.advanceTimersByTime(61000);
  expect(sessionToken()).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem('clarity-editor-signout')).toBeNull();
});

it('a server-rejected per-tab token leaves a different remembered token and does not sign out other tabs', () => {
  const rejected = token();
  setSession(rejected); // This tab, without Remember me.
  const remembered = token() + 'x';
  localStorage.setItem(key, remembered);
  dropRejectedSession(rejected);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem(key)).toBe(remembered);
  expect(localStorage.getItem('clarity-editor-signout')).toBeNull();
});

it('completes a real cross-tab callback once and rejects forged, missing, and expired echoes', () => {
  vi.useFakeTimers();
  const nonce = rememberSignIn(true);
  const value = token();
  sessionStorage.clear();
  const takeReturnPath = vi.fn(() => '/');
  const deps = { setSession, consumePendingSignIn, takeReturnPath };
  const complete = (client: string | null) =>
    completeCallback(
      new URLSearchParams({
        session: value,
        ...(client === null ? {} : { client }),
      }),
      deps,
    );
  expect(complete(null).kind).toBe('error');
  expect(complete(crypto.randomUUID()).kind).toBe('error');
  expect(takeReturnPath).not.toHaveBeenCalled();
  expect(complete(nonce).kind).toBe('signed-in');
  expect(localStorage.getItem(key)).toBe(value);
  expect(complete(nonce).kind).toBe('error');
  const expired = rememberSignIn(false);
  vi.advanceTimersByTime(600001);
  expect(complete(expired).kind).toBe('error');
  expect(takeReturnPath).toHaveBeenCalledOnce();
});

it('prepares a new-tab link and refreshes the nonce and preference on checkbox and Ctrl-click activation', async () => {
  vi.stubEnv('VITE_API_URL', 'https://api.example');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetModules();
  const { IdentityStatus } = await import('../features/auth/AuthStatus');
  const { useAuthStore } = await import('../stores/auth');
  useAuthStore.setState({ user: null, loading: false, error: null });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = () => new URL(host.querySelector('a')!.href).searchParams.get('client');
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(IdentityStatus)));
    });
    const prepared = client();
    expect(prepared).toMatch(/^[0-9a-f-]{36}$/);
    sessionStorage.clear(); // A middle-click/context-menu callback uses only the prepared href.
    expect(consumePendingSignIn(prepared)).toBe(true);
    await act(async () => {
      host.querySelector('input')!.click();
    });
    const checked = client();
    expect(checked).not.toBe(prepared);
    const cancelNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', cancelNavigation, { once: true });
    await act(async () => {
      host
        .querySelector('a')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    const activated = client();
    expect(activated).not.toBe(checked);
    sessionStorage.clear();
    expect(consumePendingSignIn(activated)).toBe(true);
    const value = token();
    setSession(value);
    expect(localStorage.getItem(key)).toBe(value);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});
