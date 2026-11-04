// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { emptyProgress, reviewStorageKey } from './reviewProgress';
import { notifyCompendiumInputs } from './inputEvents';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('does no parsing or invalidation for unchanged focus, unrelated keys or selection-only updates', async () => {
  vi.stubEnv('DEV', false);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
  const { storedInputs } = await import('./storedInputs');
  const scope = 'content-cache-test';
  const key = reviewStorageKey(`${scope}|read-only`);
  const store = storedInputs(scope, 'read-only');
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  const first = store.getSnapshot();
  const parse = vi.spyOn(JSON, 'parse');
  try {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-settings' }));
    expect(parse).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    values.set(key, JSON.stringify({ ...emptyProgress(), selected: 123, query: 'query' }));
    notifyCompendiumInputs(key);
    expect(store.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
    values.set(
      key,
      JSON.stringify({
        ...emptyProgress(),
        decisions: { 123: { kind: 'no-equivalent', fingerprint: 'source' } },
      }),
    );
    notifyCompendiumInputs(key);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().progress.decisions[123].kind).toBe('no-equivalent');
    expect(listener).toHaveBeenCalledTimes(1);
    parse.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(parse).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    parse.mockRestore();
  }
});
