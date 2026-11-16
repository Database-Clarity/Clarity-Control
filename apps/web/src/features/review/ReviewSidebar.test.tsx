// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import type { PendingTooltip } from './model';
import { useReviewQueue } from './queueStore';
import { ReviewSidebar } from './ReviewSidebar';
import { useAuthStore } from '../../stores/auth';

const entry = (
  hash: number,
  categoryId: string,
  { markerOnly = false, unpublishable }: { markerOnly?: boolean; unpublishable?: string } = {},
): PendingTooltip => ({
  tooltip: { hash, text: { en: { text: 'Text', updatedAt: '', updatedBy: '' } }, associated: [] },
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
  // "Include all" is drawn only for a role that can publish.
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'maintainer' } });
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
    leftovers: 'hidden',
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

it('lists groups with counts; leftovers are one quiet line until Show adds their collapsed group', async () => {
  expect(rows()).toEqual([1, 2, 4]);
  expect(header('a').textContent).toBe('Label a2');
  expect(header('~marker-only')).toBeNull();
  expect(host.textContent).toContain(
    '2 migration leftovers hidden: their text already matches live.',
  );
  expect(host.querySelector('a[aria-current="page"]')?.getAttribute('data-review-hash')).toBe('1');
  // Each row says what it is without a visit.
  expect(host.querySelector('a[data-review-hash="1"] small')?.textContent).toBe('New');
  expect(host.querySelector('a[data-review-hash="2"] small')?.textContent).toBe('On hold');
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show')!);
  expect(host.textContent).not.toContain('leftovers hidden');
  expect(header('~marker-only').textContent).toBe('Migration leftovers2');
  expect(header('~marker-only').getAttribute('aria-expanded')).toBe('false');
  await click(header('~marker-only'));
  expect(rows()).toEqual([1, 2, 4, 3, 5]);
  expect(host.querySelector('a[data-review-hash="3"] small')?.textContent).toBe('Leftover');
  await click(header('a'));
  expect(rows()).toEqual([4, 3, 5]);
  expect(header('a').getAttribute('aria-expanded')).toBe('false');
  await click(header('a'));
  await click(header('~marker-only'));
  expect(rows()).toEqual([1, 2, 4]);
});

it('selects rows and whole groups, never unpublishable or leftover rows in bulk', async () => {
  const groupBox = host.querySelector<HTMLInputElement>('input[data-review-group-toggle="a"]')!;
  expect(host.querySelector<HTMLInputElement>('input[data-review-toggle="2"]')!.disabled).toBe(
    true,
  );
  await click(groupBox);
  expect(selected()).toEqual([1]);
  expect(groupBox.checked).toBe(true);
  await click(host.querySelector('input[data-review-toggle="4"]')!);
  expect(selected()).toEqual([1, 4]);
  await click(groupBox);
  expect(selected()).toEqual([4]);
  // Leftovers can still be picked one at a time, and have no group checkbox.
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show')!);
  expect(host.querySelector('input[data-review-group-toggle="~marker-only"]')).toBeNull();
  await click(header('~marker-only'));
  await click(host.querySelector('input[data-review-toggle="5"]')!);
  expect(selected()).toEqual([4, 5]);
  // Selecting never navigates.
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=1');
});

it('keys: arrows and Tab move between rows, Space ticks, a click opens and closes the sheet', async () => {
  const name = (hash: number) =>
    host.querySelector<HTMLAnchorElement>(`a[data-review-hash="${hash}"]`)!;
  const edit = (hash: number) =>
    host.querySelector<HTMLAnchorElement>(`a[data-review-edit="${hash}"]`)!;
  await act(async () => name(1).focus());
  const press = (key: string, shiftKey = false) =>
    act(async () => {
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    });
  await press(' ');
  expect(selected()).toEqual([1]);
  await press(' ');
  expect(selected()).toEqual([]);
  // Tab from a name goes on natively to its editor link; from the link to the next row.
  expect(await press('Tab')).toBe(false);
  await act(async () => edit(1).focus());
  expect(await press('Tab')).toBe(true);
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

it('every row opens straight in the editor', async () => {
  const link = host.querySelector<HTMLAnchorElement>('a[data-review-edit="4"]')!;
  expect(link.getAttribute('href')).toBe('/t/4');
  expect(link.getAttribute('aria-label')).toBe('Open Name 4 in editor');
  await click(link);
  expect(host.querySelector('output')?.textContent).toBe('/t/4');
});

it('filters by find and kind; "Include all N" ticks exactly the publishable rows shown', async () => {
  const search = host.querySelector<HTMLInputElement>('input[type=search]')!;
  const kind = host.querySelector<HTMLSelectElement>('select[aria-label="Kind of change"]')!;
  expect([...kind.options].map((option) => option.textContent)).toEqual([
    'All kinds',
    'New (2)',
    'On hold (1)',
  ]);
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        value,
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const choose = (value: string) =>
    act(async () => {
      kind.value = value;
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const button = (label: RegExp) =>
    [...host.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
  await type('label a');
  expect(rows()).toEqual([1, 2]);
  expect(host.textContent).toContain('2 shown');
  // The held row is shown but never ticked in bulk.
  expect(button(/^Include all/)?.textContent).toBe('Include all 1');
  await click(button(/^Include all/)!);
  expect(selected()).toEqual([1]);
  expect(button(/^All 1 included$/)?.disabled).toBe(true);
  await type('');
  await choose('New');
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=1&kind=New');
  expect(rows()).toEqual([1, 4]);
  await click(button(/^Include all/)!);
  expect(selected()).toEqual([1, 4]);
  await type('zzz');
  expect(host.textContent).toContain('No change matches.');
  await click(button(/^Clear filters$/)!);
  expect(rows()).toEqual([1, 2, 4]);
  // The open change still matched: it stays open.
  expect(host.querySelector('output')?.textContent).toBe('/review?hash=1');
});

it('"Include all N" ticks only rows on screen, and is not drawn for a role that cannot publish', async () => {
  // Security review 1 findings 3 and 4.
  const kind = host.querySelector<HTMLSelectElement>('select[aria-label="Kind of change"]')!;
  await act(async () => {
    kind.value = 'New';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(rows()).toEqual([1, 4]);
  // Collapse group b: its row is no longer shown, so it is no longer counted or ticked.
  await click(header('b'));
  expect(rows()).toEqual([1]);
  expect(host.textContent).toContain('1 shown');
  const all = [...host.querySelectorAll('button')].find((b) =>
    /^Include all/.test(b.textContent ?? ''),
  )!;
  expect(all.textContent).toBe('Include all 1');
  await click(all);
  expect(selected()).toEqual([1]);
  await click(header('b'));
  await act(async () =>
    useAuthStore.setState({ user: { id: 2, login: 'reader', role: 'translator' } }),
  );
  expect(
    [...host.querySelectorAll('button')].some((b) => /^Include all/.test(b.textContent ?? '')),
  ).toBe(false);
});
