// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ReviewQueue } from './ReviewQueue';

it('bounds a long queue, reveals deep URL selections, and keeps keyboard access across windows', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const heightRead = vi.spyOn(Element.prototype, 'clientHeight', 'get');
  heightRead.mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-review-row-size')) return 64;
    if (this.getAttribute('aria-label') === 'Scroll pending saved changes') return 1600;
    return 0;
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
      observe() {}
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
    const scroller = host.querySelector<HTMLElement>(
      '[aria-label="Scroll pending saved changes"]',
    )!;
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
    // Only initial window sizing may measure; selection and key/scroll updates
    // must use observed bounds, without forcing the workspace layout again.
    expect(heightRead).toHaveBeenCalledTimes(initialHeightReads);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    heightRead.mockRestore();
  }
});
