// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TooltipDiff } from './TooltipDiff';

it('keeps all language text while revealing offscreen comparisons on scroll', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let intersect: IntersectionObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  const current = {
    hash: 1,
    associated: [],
    text: {
      en: { text: 'English comparison', updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' },
      ko: { text: '한국어 비교', updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' },
    },
  };
  try {
    await act(async () => root.render(<TooltipDiff before={null} current={current} raw={false} />));
    const sections = host.querySelectorAll('section');
    expect(sections[0].hasAttribute('data-deferred')).toBe(false);
    expect(sections[1].hasAttribute('data-deferred')).toBe(true);
    expect(sections[1].textContent).toContain('한국어 비교');
    await act(async () =>
      intersect?.(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(sections[1].hasAttribute('data-deferred')).toBe(false);
    expect(sections[1].textContent).toContain('한국어 비교');
    expect(disconnect).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
