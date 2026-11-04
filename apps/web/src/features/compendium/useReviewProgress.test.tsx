// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notifyCompendiumInputs } from './inputEvents';
import { emptyProgress, readProgress } from './reviewProgress';
import { useReviewProgress } from './useReviewProgress';

vi.mock('./inputEvents', () => ({ notifyCompendiumInputs: vi.fn() }));
let root: Root;
let state: ReturnType<typeof useReviewProgress>;
let write: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
let values: Map<string, string>;
let idle: Map<number, IdleRequestCallback>;
let idleId: number;
function Queue({ storageKey }: { storageKey: string }) {
  state = useReviewProgress(storageKey);
  return null;
}
function mount(storageKey = 'review-navigation') {
  act(() => root.render(createElement(Queue, { key: storageKey, storageKey })));
}
function finishIdle() {
  act(() => vi.advanceTimersByTime(150));
  act(() => {
    for (const callback of [...idle.values()])
      callback({ didTimeout: false, timeRemaining: () => 10 });
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  values = new Map();
  write = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: write,
  });
  idle = new Map();
  idleId = 0;
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn((callback: IdleRequestCallback) => {
      idle.set(++idleId, callback);
      return idleId;
    }),
  );
  vi.stubGlobal(
    'cancelIdleCallback',
    vi.fn((id: number) => idle.delete(id)),
  );
  vi.mocked(notifyCompendiumInputs).mockClear();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  // Complete retained jobs even in the storage-failure case, before restoring globals.
  write.mockImplementation((key: string, value: string) => {
    values.set(key, value);
  });
  act(() => window.dispatchEvent(new Event('pagehide')));
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('coalesces navigation, writes only at idle, and skips unchanged updates', () => {
  mount();
  act(() => {
    state.update((current) => ({ ...current, selected: 1 }));
    state.update((current) => ({ ...current, query: 'latest' }));
    state.update((current) => ({ ...current, selected: 2 }));
  });
  expect(state.progress).toMatchObject({ selected: 2, query: 'latest' });
  expect(write).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(149));
  expect(idle.size).toBe(0);
  act(() => vi.advanceTimersByTime(1));
  expect(write).not.toHaveBeenCalled();
  expect(window.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
  finishIdle();
  expect(write).toHaveBeenCalledTimes(1);
  expect(readProgress(localStorage, 'review-navigation')).toMatchObject({
    selected: 2,
    query: 'latest',
  });
  act(() => state.update((current) => ({ ...current })));
  finishIdle();
  expect(write).toHaveBeenCalledTimes(1);
  expect(notifyCompendiumInputs).not.toHaveBeenCalled();
});

it('flushes the latest view on pagehide, without a duplicate idle write', () => {
  mount();
  act(() => state.update((current) => ({ ...current, category: 'armor' })));
  act(() => vi.advanceTimersByTime(150));
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(readProgress(localStorage, 'review-navigation').category).toBe('armor');
  finishIdle();
  expect(write).toHaveBeenCalledTimes(1);
});

it('retains pending navigation across route unmounts and isolates account keys', () => {
  mount('account-a');
  act(() => state.update((current) => ({ ...current, selected: 42 })));
  act(() => root.render(null));
  expect(write).not.toHaveBeenCalled();
  mount('account-b');
  expect(state.progress.selected).toBeUndefined();
  mount('account-a');
  expect(state.progress.selected).toBe(42);
  finishIdle();
  expect(readProgress(localStorage, 'account-a').selected).toBe(42);
  expect(localStorage.getItem('account-b')).toBeNull();
});

it('preserves decisions saved by another tab while navigation waits', () => {
  mount();
  act(() => state.update((current) => ({ ...current, selected: 2 })));
  const decisions = { 7: { kind: 'skipped' as const, fingerprint: 'external' } };
  localStorage.setItem('review-navigation', JSON.stringify({ ...emptyProgress(), decisions }));
  write.mockClear();
  finishIdle();
  expect(readProgress(localStorage, 'review-navigation')).toMatchObject({ selected: 2, decisions });
  expect(write).toHaveBeenCalledTimes(1);
  expect(notifyCompendiumInputs).not.toHaveBeenCalled();
});

it('keeps authored decisions durable and cancels an older pending navigation write', () => {
  mount();
  act(() => state.update((current) => ({ ...current, selected: 1 })));
  const decisions = { 1: { kind: 'no-equivalent' as const, fingerprint: 'source' } };
  act(() => state.update((current) => ({ ...current, selected: 2, decisions })));
  expect(write).toHaveBeenCalledTimes(1);
  expect(readProgress(localStorage, 'review-navigation')).toMatchObject({ selected: 2, decisions });
  expect(notifyCompendiumInputs).toHaveBeenCalledExactlyOnceWith('review-navigation');
  finishIdle();
  expect(write).toHaveBeenCalledTimes(1);
});

it('skips a queued write when storage already has the same value', () => {
  mount();
  act(() => state.update((current) => ({ ...current, selected: 2 })));
  localStorage.setItem('review-navigation', JSON.stringify(state.progress));
  write.mockClear();
  finishIdle();
  expect(write).not.toHaveBeenCalled();
});

it('reports failed idle writes, retains memory state, and retries on pagehide', () => {
  mount();
  write.mockImplementationOnce(() => {
    throw new Error('Storage full');
  });
  act(() => state.update((current) => ({ ...current, query: 'retained' })));
  finishIdle();
  expect(state.progress.query).toBe('retained');
  expect(state.error).toContain('Storage full');
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(readProgress(localStorage, 'review-navigation').query).toBe('retained');
  expect(state.error).toBe('');
});

it('does not clear a failed decision warning after successfully saving only view state', () => {
  mount();
  write.mockImplementationOnce(() => {
    throw new Error('Decision not saved');
  });
  act(() =>
    state.update((current) => ({
      ...current,
      decisions: { 1: { kind: 'skipped', fingerprint: 'source' } },
    })),
  );
  act(() => state.update((current) => ({ ...current, selected: 2 })));
  finishIdle();
  expect(state.error).toContain('Decision not saved');
  expect(state.progress.decisions[1].kind).toBe('skipped');
  expect(readProgress(localStorage, 'review-navigation').decisions).toEqual({});
});

it('flushes on hidden visibility and uses a deferred fallback without idle callbacks', () => {
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.stubGlobal('cancelIdleCallback', undefined);
  mount();
  act(() => state.update((current) => ({ ...current, selected: 3 })));
  expect(write).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(151));
  expect(readProgress(localStorage, 'review-navigation').selected).toBe(3);
  act(() => state.update((current) => ({ ...current, selected: 4 })));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(readProgress(localStorage, 'review-navigation').selected).toBe(4);
});
