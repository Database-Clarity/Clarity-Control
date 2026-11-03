// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { phoneQuery, useMedia } from './useMedia';

describe('useMedia', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.unstubAllGlobals();
  });

  it('subscribes once per query, not once per render', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const add = vi.fn();
    const remove = vi.fn();
    let change: () => void = () => {};
    let matches = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, listener: () => void) => {
          add();
          change = listener;
        },
        removeEventListener: remove,
      }),
    });
    function Probe({ tick }: { tick: number }) {
      return <span data-tick={tick}>{String(useMedia(phoneQuery))}</span>;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe tick={0} />));
    for (let tick = 1; tick <= 5; tick++) act(() => root.render(<Probe tick={tick} />));
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(host.textContent).toBe('false');
    matches = true;
    act(() => change());
    expect(host.textContent).toBe('true');
    act(() => root.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
