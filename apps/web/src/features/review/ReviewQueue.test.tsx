// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ReviewQueue } from './ReviewQueue';

it('bounds a long queue, reveals deep URL selections, and keeps keyboard access across windows', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const heightRead = vi.spyOn(Element.prototype, 'clientHeight', 'get');
  heightRead.mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-review-row-size')) return 69;
    if (this.getAttribute('aria-label') === 'Scroll pending saved changes') return 1600;
    return 0;
  });
  const rowBounds = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      return { height: this.hasAttribute('data-review-row-size') ? 69.12 : 0 } as DOMRect;
    });
  const changes = Array.from({ length: 2500 }, (_, hash) => ({
    hash,
    name: `Tooltip ${hash}`,
    category: 'Perk',
  }));
  let resize!: ResizeObserverCallback;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe(target: Element) {
        queueMicrotask(() =>
          resize(
            [
              {
                target,
                contentRect: {
                  height: target.hasAttribute('data-review-row-size') ? 69.12 : 1600,
                },
              } as unknown as ResizeObserverEntry,
            ],
            {} as ResizeObserver,
          ),
        );
      }
      disconnect() {}
    },
  );
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ReviewQueue changes={changes} selectedHash="1800" />
        </MemoryRouter>,
      ),
    );
    const initialHeightReads = heightRead.mock.calls.length;
    expect(initialHeightReads).toBe(0);
    expect(rowBounds).not.toHaveBeenCalled();
    const scroller = host.querySelector<HTMLElement>(
      '[aria-label="Scroll pending saved changes"]',
    )!;
    expect(scroller.scrollTop).toBeCloseTo(1800 * 69.12);
    const renderedBottom = Math.max(
      ...[...host.querySelectorAll<HTMLElement>('li')].map(
        (row) => Number.parseFloat(row.style.top) + Number.parseFloat(row.style.height),
      ),
    );
    expect(renderedBottom).toBeGreaterThanOrEqual(scroller.scrollTop + 1600);
    expect(host.querySelectorAll('li').length).toBeLessThan(30);
    let selected = host.querySelector<HTMLAnchorElement>('[aria-current="page"]')!;
    expect(selected.getAttribute('href')).toBe('/review?hash=1800');
    await act(async () => {
      resize(
        [
          {
            target: host.querySelector('[data-review-row-size]')!,
            contentRect: { height: 96 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    selected = host.querySelector<HTMLAnchorElement>('[aria-current="page"]')!;
    expect(selected.closest('li')?.style.height).toBe('96px');
    expect(
      host.querySelector<HTMLElement>('[aria-label="Scroll pending saved changes"]')?.scrollTop,
    ).toBe(1800 * 96);
    await act(async () => selected.focus());
    await act(async () =>
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=2499');
    expect(host.querySelectorAll('li').length).toBeLessThan(30);
    await act(async () => {
      const scroller = host.querySelector<HTMLElement>(
        '[aria-label="Scroll pending saved changes"]',
      )!;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=2499');
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      ),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=0');
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      ),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=1');
    // Native observation, selection, and key/scroll updates must not force the
    // workspace layout through synchronous geometry reads.
    expect(heightRead).toHaveBeenCalledTimes(initialHeightReads);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    heightRead.mockRestore();
    rowBounds.mockRestore();
  }
});

it('coalesces wheel deltas before scrolling, preserves zoom/chaining, and cancels superseded input', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', undefined);
  const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
  const bounds = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({ height: 64 } as DOMRect);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes = Array.from({ length: 1000 }, (_, hash) => ({
    hash,
    name: `Tooltip ${hash}`,
    category: 'Perk',
  }));
  let unmounted = false;
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ReviewQueue changes={changes} selectedHash="0" />
        </MemoryRouter>,
      ),
    );
    const scroller = host.querySelector<HTMLElement>(
      '[aria-label="Scroll pending saved changes"]',
    )!;
    let physicalTop = 0;
    let inspectMove = true;
    const movedWindows: { first: number; last: number; top: number }[] = [];
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => physicalTop,
      set: (top: number) => {
        if (inspectMove) {
          const rows = [...scroller.querySelectorAll<HTMLElement>('li')];
          movedWindows.push({
            first: Math.min(...rows.map((row) => Number.parseFloat(row.style.top))),
            last: Math.max(
              ...rows.map(
                (row) => Number.parseFloat(row.style.top) + Number.parseFloat(row.style.height),
              ),
            ),
            top,
          });
        }
        physicalTop = top;
      },
    });
    const wheel = (deltaY: number, ctrlKey = false) => {
      const event = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true });
      scroller.dispatchEvent(event);
      return event;
    };
    expect(wheel(200).defaultPrevented).toBe(true);
    wheel(300);
    wheel(-100);
    expect(frames.size).toBe(1);
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      const [id, callback] = [...frames][0];
      frames.delete(id);
      callback(1);
    });
    expect(scroller.scrollTop).toBe(400);
    expect(movedWindows).toHaveLength(1);
    expect(movedWindows[0].first).toBeLessThanOrEqual(400);
    expect(movedWindows[0].last).toBeGreaterThanOrEqual(800);
    inspectMove = false;
    expect(host.querySelector('li')?.getAttribute('data-index')).toBe('5');
    expect(wheel(100, true).defaultPrevented).toBe(false);
    const horizontal = new WheelEvent('wheel', {
      deltaY: 100,
      shiftKey: true,
      cancelable: true,
    });
    scroller.dispatchEvent(horizontal);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    const anchor = host.querySelector<HTMLAnchorElement>('li a')!;
    await act(async () => anchor.focus());
    wheel(100);
    expect(frames.size).toBe(1);
    await act(async () =>
      anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    expect(frames.size).toBe(0);
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=999');
    await act(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    wheel(100);
    expect(frames.size).toBe(1);
    await act(async () => root.unmount());
    unmounted = true;
    expect(frames.size).toBe(0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    host.remove();
    height.mockRestore();
    bounds.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('preserves native link modifiers and current-route replacement with one queue handler', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Location() {
    const location = useLocation();
    const type = useNavigationType();
    return (
      <output>
        {type}:{location.pathname}
        {location.search}
      </output>
    );
  }
  const changes = Array.from({ length: 3 }, (_, hash) => ({
    hash,
    name: `Tooltip ${hash}`,
    category: 'Perk',
  }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter basename="/app" initialEntries={['/app/review']}>
          <ReviewQueue changes={changes} selectedHash={null} />
          <Location />
        </MemoryRouter>,
      ),
    );
    const first = host.querySelector<HTMLAnchorElement>('[data-index="1"] a')!;
    const second = host.querySelector<HTMLAnchorElement>('[data-index="2"] a')!;
    expect(host.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(
      '/app/review?hash=0',
    );
    expect(first.getAttribute('href')).toBe('/app/review?hash=1');
    const prevented: boolean[] = [];
    // Observe after React's delegated handler, then prevent jsdom's unsupported
    // document navigation for links deliberately left to the browser.
    host.addEventListener('click', (event) => {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    });
    const click = async (anchor: HTMLAnchorElement, options: MouseEventInit = {}) =>
      act(async () =>
        anchor.dispatchEvent(
          new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...options }),
        ),
      );
    await click(first);
    expect(host.querySelector('output')?.textContent).toBe('PUSH:/review?hash=1');
    expect(prevented.at(-1)).toBe(true);
    await click(first);
    expect(host.querySelector('output')?.textContent).toBe('REPLACE:/review?hash=1');
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      await click(second, options);
      expect(prevented.at(-1)).toBe(false);
      expect(host.querySelector('output')?.textContent).toBe('REPLACE:/review?hash=1');
    }
    second.target = '_blank';
    await click(second);
    expect(prevented.at(-1)).toBe(false);
    second.removeAttribute('target');
    second.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await click(second);
    expect(host.querySelector('output')?.textContent).toBe('REPLACE:/review?hash=1');
    await click(second);
    expect(host.querySelector('output')?.textContent).toBe('PUSH:/review?hash=2');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
