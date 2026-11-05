// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { MatchedSourceList, matchedSourceRows } from './MatchedSources';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture(count = 300) {
  const { editor, source } = guidedFixture();
  const item = Object.values(editor.items)[0];
  const match = { tab: source.tabs[0], row: source.tabs[0].rows[0] };
  editor.items = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      10_000 + index,
      { ...item, hash: 10_000 + index, name: `Item ${String(index).padStart(3, '0')}` },
    ]),
  );
  const matches = new Map(
    Array.from({ length: count }, (_, index) => [
      10_000 + index,
      { ...match, row: { ...match.row, name: `Source ${index}` } },
    ]),
  );
  return { editor, matches };
}

it('reuses sorted source rows while invalidating source and catalog revisions', () => {
  const { editor, matches } = fixture(3);
  const rows = matchedSourceRows(editor, matches);
  expect(rows.map((row) => row.item?.name)).toEqual(['Item 000', 'Item 001', 'Item 002']);
  expect(matchedSourceRows(editor, matches)).toBe(rows);
  const revised = new Map(matches);
  const previous = revised.get(10_000)!;
  revised.set(10_000, { ...previous, row: { ...previous.row, name: 'Revised evidence' } });
  const updated = matchedSourceRows(editor, revised);
  expect(updated).not.toBe(rows);
  expect(updated[0].search).toContain('revised evidence');
  expect(rows[0].search).toContain('source 0');
  const renamed = {
    ...editor,
    items: { ...editor.items, 10_000: { ...editor.items[10_000], name: 'Zulu' } },
  };
  expect(matchedSourceRows(renamed, revised).map((row) => row.item?.name)).toEqual([
    'Item 001',
    'Item 002',
    'Zulu',
  ]);
});

it('windows jumped-to rows, retains focus, and mounts the next native Tab destination', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const observed = new Set<Element>();
  let notify!: ResizeObserverCallback;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe(node: Element) {
        observed.add(node);
      }
      unobserve(node: Element) {
        observed.delete(node);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const { editor, matches } = fixture();
  const rows = matchedSourceRows(editor, matches);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (shown = rows) =>
    root.render(
      createElement(MemoryRouter, null, createElement(MatchedSourceList, { rows: shown })),
    );
  try {
    await act(() => render());
    const list = host.querySelector('ul')!;
    const mounted = () => [...list.querySelectorAll<HTMLElement>('li[data-matched-hash]')];
    expect(mounted().length).toBeGreaterThan(5);
    expect(mounted().length).toBeLessThan(40);
    expect(mounted()[0].getAttribute('aria-setsize')).toBe('300');
    await act(() => {
      notify(
        [...observed].map(
          (target) =>
            ({
              target,
              contentRect: { width: 320, height: target === list ? 384 : 48 },
              borderBoxSize: [{ inlineSize: 320, blockSize: 48 }],
            }) as unknown as ResizeObserverEntry,
        ),
        {} as ResizeObserver,
      );
    });
    const first = mounted()[0].querySelector('a')!;
    await act(() => first.focus());
    await act(() => {
      list.scrollTop = 4000;
      list.dispatchEvent(new Event('scroll'));
    });
    expect(document.activeElement).toBe(first);
    expect(first.isConnected).toBe(true);
    expect(mounted().length).toBeLessThan(40);
    expect(mounted().some((row) => Number(row.dataset.matchedHash) > 10_030)).toBe(true);
    expect(list.querySelector('li[role="presentation"]')?.getAttribute('aria-hidden')).toBe('true');

    const last = mounted().at(-1)!;
    const lastHash = Number(last.dataset.matchedHash);
    const link = last.querySelector('a')!;
    await act(() => link.focus());
    expect(list.querySelector(`a[href="/t/${lastHash + 1}"]`)).toBeNull();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(() => link.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    expect(list.querySelector(`a[href="/t/${lastHash + 1}"]`)).not.toBeNull();

    await act(() => {
      list.scrollTop = 1_000_000;
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.querySelector('a[href="/t/10299"]')).not.toBeNull();
    expect(mounted().length).toBeLessThan(40);
    await act(() => render(rows.slice(0, 3)));
    expect(mounted()).toHaveLength(3);
    expect(mounted().map((row) => row.getAttribute('aria-setsize'))).toEqual(['3', '3', '3']);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
