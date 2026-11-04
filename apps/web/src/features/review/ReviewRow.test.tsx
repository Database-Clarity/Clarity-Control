// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReviewRow } from './ReviewRow';
import { getHistory } from '../../services/history';
import type { PendingTooltip } from './model';

vi.mock('../../services/history', () => ({
  getHistory: vi.fn(async () => ({ page: 1, commits: [] })),
}));

it('loads latest-change metadata on proximity without changing row selection', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let intersect!: IntersectionObserverCallback;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div'),
    root = createRoot(host);
  const toggle = vi.fn(),
    open = vi.fn();
  const entry = {
    tooltip: { hash: 42, text: {}, associated: [] },
    name: 'Perk',
    category: 'Perks',
    categoryId: 'perk',
    categoryOrder: 1,
  } as PendingTooltip;
  try {
    await act(async () =>
      root.render(
        <ul>
          <ReviewRow
            entry={entry}
            checked={false}
            active={false}
            disabled={false}
            historyAvailable
            onToggle={toggle}
            onOpen={open}
          />
        </ul>,
      ),
    );
    expect(getHistory).not.toHaveBeenCalled();
    await act(async () =>
      intersect(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(getHistory).toHaveBeenCalledExactlyOnceWith(42, 1, expect.any(AbortSignal));
    expect(host.textContent).toContain('No history available');
    expect(toggle).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
