// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import type { PendingTooltip } from './model';
import { useReviewQueue } from './queueStore';
import { ReviewSidebar } from './ReviewSidebar';

const entry = (
  hash: number,
  categoryId: string,
  { markerOnly = false, unpublishable }: { markerOnly?: boolean; unpublishable?: string } = {},
): PendingTooltip => ({
  tooltip: { hash, text: {}, associated: [] },
  name: `Name ${hash}`,
  category: `Label ${categoryId}`,
  categoryId,
  categoryOrder: 0,
  markerOnly,
  isNew: !markerOnly,
  ...(unpublishable ? { unpublishable } : {}),
});

let host: HTMLDivElement;
let root: Root;
const closeSheet = vi.fn();

function Location() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useReviewQueue.setState({
    entries: [
      entry(1, 'a'),
      entry(2, 'a', { unpublishable: 'No generator entry' }),
      entry(4, 'b'),
      entry(3, 'a', { markerOnly: true }),
      entry(5, 'b', { markerOnly: true }),
    ],
    selected: new Set(),
    collapsed: new Set(),
    markerOpen: false,
    scrollTop: 0,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/review?hash=1']}>
        <FinderSheetCloseContext.Provider value={closeSheet}>
          <ReviewSidebar />
        </FinderSheetCloseContext.Provider>
        <Location />
      </MemoryRouter>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useReviewQueue.setState({ entries: null, selected: new Set(), collapsed: new Set() });
  closeSheet.mockReset();
});

const rows = () =>
  [...host.querySelectorAll<HTMLAnchorElement>('a[data-review-hash]')].map((a) =>
    Number(a.dataset.reviewHash),
  );
const header = (id: string) =>
  host.querySelector<HTMLButtonElement>(`button[data-review-group="${id}"]`)!;
const selected = () => [...useReviewQueue.getState().selected].sort();
const click = (element: Element) => act(async () => (element as HTMLElement).click());

it('lists groups with counts, marker-only collapsed last, and toggles groups open and shut', async () => {
  expect(rows()).toEqual([1, 2, 4]);
  expect(header('a').textContent).toBe('▾Label a2');
  expect(header('~marker-only').textContent).toBe('▸Marker-only2');
  expect(header('~marker-only').getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent).toContain('Alias-marker migration leftovers');
  expect(host.querySelector('a[aria-current="page"]')?.getAttribute('data-review-hash')).toBe('1');
  await click(header('~marker-only'));
  expect(rows()).toEqual([1, 2, 4, 3, 5]);
  expect(host.textContent).not.toContain('Alias-marker migration leftovers');
  await click(header('a'));
  expect(rows()).toEqual([4, 3, 5]);
  expect(header('a').getAttribute('aria-expanded')).toBe('false');
  await click(header('a'));
  await click(header('~marker-only'));
  expect(rows()).toEqual([1, 2, 4]);
});

it('selects rows and whole groups, never unpublishable or marker-only rows in bulk', async () => {
  const groupBox = host.querySelector<HTMLInputElement>('input[data-review-group-toggle="a"]')!;
  expect(host.querySelector('input[data-review-group-toggle="~marker-only"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[data-review-toggle="2"]')!.disabled).toBe(true);
  await click(groupBox);
  expect(selected()).toEqual([1]);
  expect(groupBox.checked).toBe(true);
  await click(host.querySelector('input[data-review-toggle="4"]')!);
  expect(selected()).toEqual([1, 4]);
  await click(groupBox);
  expect(selected()).toEqual([4]);
  // Marker-only rows can still be picked one at a time.
  await click(header('~marker-only'));
  await click(host.querySelector('input[data-review-toggle="5"]')!);
  expect(selected()).toEqual([4, 5]);
  // Selecting never navigates.
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=1');
});

it('keys: arrows and Tab move between rows, Space selects, a click opens and closes the sheet', async () => {
  const name = (hash: number) =>
    host.querySelector<HTMLAnchorElement>(`a[data-review-hash="${hash}"]`)!;
  await act(async () => name(1).focus());
  const press = (key: string, shiftKey = false) =>
    act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  await press(' ');
  expect(selected()).toEqual([1]);
  await press(' ');
  expect(selected()).toEqual([]);
  await press('ArrowDown');
  expect(document.activeElement).toBe(name(2));
  // The unpublishable row keeps Space inert.
  await press(' ');
  expect(selected()).toEqual([]);
  await press('ArrowDown');
  expect(document.activeElement).toBe(header('b'));
  await press('Tab');
  expect(document.activeElement).toBe(name(4));
  await press('ArrowUp');
  await press('ArrowUp');
  expect(document.activeElement).toBe(name(2));
  await click(name(4));
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=4');
  expect(closeSheet).toHaveBeenCalledTimes(1);
});

it('filters from the column, keeping the open change only while it matches', async () => {
  const search = host.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '4');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=4&query=4');
  expect(rows()).toEqual([4]);
  const category = host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
  await act(async () => {
    category.value = 'a';
    category.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('Nothing matches.');
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters')!);
  expect(rows()).toEqual([1, 2, 4]);
  // Nothing was open under the empty filter: clearing opens the first change.
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=1');
});
