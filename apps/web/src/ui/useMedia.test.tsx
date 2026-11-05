// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactQuery, phoneQuery, uiScaleEvent, useMedia } from './useMedia';

describe('useMedia', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.uiScale;
  });

  it('subscribes once per query, not once per render', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const add = vi.fn();
    const remove = vi.fn();
    let change: () => void = () => {};
    let matches = false;
    const createMedia = vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, listener: () => void) => {
        add();
        change = listener;
      },
      removeEventListener: remove,
    }));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: createMedia,
    });
    function Probe({ tick }: { tick: number }) {
      return <span data-tick={tick}>{String(useMedia(phoneQuery))}</span>;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe tick={0} />));
    for (let tick = 1; tick <= 5; tick++) act(() => root.render(<Probe tick={tick} />));
    expect(add).toHaveBeenCalledTimes(1);
    expect(createMedia).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(host.textContent).toBe('false');
    matches = true;
    act(() => change());
    expect(host.textContent).toBe('true');
    act(() => root.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('replaces the cached query when the interface scale changes its breakpoint', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const createMedia = vi.fn((query: string) => ({
      matches: query === '(max-width: 1649px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: createMedia });
    const host = document.createElement('div'),
      root = createRoot(host);
    function Probe() {
      return <span>{String(useMedia(compactQuery))}</span>;
    }
    act(() => root.render(<Probe />));
    expect(host.textContent).toBe('false');
    act(() => {
      document.documentElement.dataset.uiScale = '150';
      window.dispatchEvent(new Event(uiScaleEvent));
    });
    expect(host.textContent).toBe('true');
    expect(createMedia.mock.calls.map(([query]) => query)).toEqual([
      '(max-width: 1099px)',
      '(max-width: 1649px)',
    ]);
    act(() => root.unmount());
  });
});
