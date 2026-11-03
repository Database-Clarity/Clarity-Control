// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearSession,
  dropRejectedSession,
  rememberSignIn,
  sessionToken,
  setSession,
  subscribeSession,
} from './session';
const key = 'clarity-editor-session';
const token = () =>
  btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })) + '.signature';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
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
