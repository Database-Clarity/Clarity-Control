// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearSession,
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
