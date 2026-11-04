// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useElementWidth } from './useElementWidth';

it('uses delivered resize sizes without forcing layout when a pane mounts', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let notify!: ResizeObserverCallback;
  const observe = vi.fn(),
    disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const read = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => {
    throw new Error('Forced layout');
  });
  const host = document.createElement('div'),
    root = createRoot(host),
    ref = createRef<HTMLDivElement>();
  function Pane() {
    const width = useElementWidth(ref);
    return createElement('div', { ref }, width ?? 'Unmeasured');
  }
  try {
    await act(async () => root.render(createElement(Pane)));
    expect(host.textContent).toBe('Unmeasured');
    const resize = async (width: number) =>
      act(async () =>
        notify(
          [
            {
              target: ref.current!,
              borderBoxSize: [{ inlineSize: width, blockSize: 100 }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        ),
      );
    await resize(384);
    expect(host.textContent).toBe('384');
    await resize(240);
    expect(host.textContent).toBe('240');
    expect(read).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    read.mockRestore();
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalled();
});
