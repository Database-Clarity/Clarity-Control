// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompendiumBadge, useCompendiumCount } from './CompendiumBadge';

const test = vi.hoisted(() => ({
  drafts: {} as Record<string, object>,
  listeners: new Set<() => void>(),
  parentRenders: 0,
  matchingRenders: 0,
  editor: { bundle: { tooltips: {} } },
  source: { fetchedAt: '2026-11-05T00:00:00Z', tabs: [] },
}));
vi.mock('../../stores/data', () => ({
  useDataStore: (selector: (s: object) => unknown) => selector({ data: test.editor }),
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: object) => unknown) => selector({ user: { id: 1 } }),
}));
vi.mock('./store', () => {
  const state = { data: test.source, error: null, load: () => {} };
  return {
    useCompendiumStore: (selector?: (s: object) => unknown) => (selector ? selector(state) : state),
  };
});
vi.mock('../../stores/drafts', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useDraftStore: Object.assign(
      (selector: (s: { drafts: object }) => unknown) =>
        useSyncExternalStore(
          (listener) => {
            test.listeners.add(listener);
            return () => test.listeners.delete(listener);
          },
          () => selector({ drafts: test.drafts }),
        ),
      { getState: () => ({ drafts: test.drafts }) },
    ),
  };
});
vi.mock('./useDisplayMatches', () => ({
  useDisplayMatches: () => {
    test.matchingRenders++;
    return { prepared: null };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.unstubAllGlobals();
  test.listeners.clear();
  test.parentRenders = 0;
  test.matchingRenders = 0;
});

it('keeps draft/matching subscriptions below the count consumer render boundary, even for a zero badge', () => {
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('cancelIdleCallback', () => {});
  function Parent() {
    test.parentRenders++;
    return createElement(CompendiumBadge, { count: useCompendiumCount() });
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(Parent)));
    expect(test.parentRenders).toBe(1);
    expect(test.matchingRenders).toBe(1);
    expect(host.textContent).toBe('');
    act(() => {
      test.drafts = { edit: {} };
      for (const listener of test.listeners) listener();
    });
    expect(test.parentRenders).toBe(1);
    expect(test.matchingRenders).toBe(2);
    expect(host.textContent).toBe('');
  } finally {
    act(() => root.unmount());
  }
});

it('preserves loading, failure, and ready accessible badge output', () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(CompendiumBadge, { count: { state: 'loading' } })));
    expect(host.querySelector('.sr-only')?.textContent).toBe('Compendium changes loading');
    act(() => root.render(createElement(CompendiumBadge, { count: { state: 'error' } })));
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Compendium unavailable',
    );
    act(() => root.render(createElement(CompendiumBadge, { count: { state: 'ready', count: 3 } })));
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '3 Compendium changes',
    );
    expect(host.textContent).toBe('3');
  } finally {
    act(() => root.unmount());
  }
});
