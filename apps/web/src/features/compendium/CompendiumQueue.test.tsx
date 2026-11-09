// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompendiumQueue } from './CompendiumQueue';
import { useCompendiumQueueStore, emptyCounts } from './queueStore';
import { buildQueue } from './queueView';
import type { QueueRow } from './queueRows';

let host: HTMLDivElement;
let root: Root;

function Route() {
  const location = useLocation();
  return createElement('output', { 'data-route': '' }, location.search);
}

const rows: QueueRow[] = Array.from({ length: 40 }, (_, i) => ({
  hash: 100 + i,
  name: `Entry ${i}`,
  category: i < 20 ? 'a' : 'b',
  kind: 'proposal' as const,
}));
const categories = new Map([
  ['a', { id: 'a', label: 'Alpha', order: 1 }],
  ['b', { id: 'b', label: 'Beta', order: 2 }],
]);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  useCompendiumQueueStore.setState({
    rows,
    counts: { ...emptyCounts, open: 40 },
    categories,
    toggled: new Set(),
    selected: 100,
    model: buildQueue({
      rows,
      filters: { show: 'open', query: '', group: '' },
      categories,
      toggled: new Set(),
    }),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const mount = async (path = '/compendium') =>
  act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Fragment, null, createElement(Route), createElement(CompendiumQueue)),
      ),
    ),
  );

it('lists group headers with counts and only the rows in the window', async () => {
  await mount();
  const headers = [...host.querySelectorAll('button[aria-expanded]')].map((b) => b.textContent);
  expect(headers[0]).toContain('Alpha');
  expect(headers[0]).toContain('20');
  const rendered = host.querySelectorAll('[role="treeitem"][aria-level="2"]');
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThan(40);
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('Entry 0');
});

it('keeps fast typing intact and follows it into the URL once typing pauses', async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>('[data-compendium-search]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (const value of ['R', 'Ra', 'Ram', 'Ramp']) {
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  expect(input.value).toBe('Ramp');
  expect(host.querySelector('[data-route]')!.textContent).toBe('');
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  expect(host.querySelector('[data-route]')!.textContent).toBe('?q=Ramp');
  expect(input.value).toBe('Ramp');
});

it('clicking a row selects it by replacing the route', async () => {
  await mount('/compendium?tab=linked&show=all');
  await act(async () => {
    host.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]')[1].click();
  });
  const search = new URLSearchParams(host.querySelector('[data-route]')!.textContent!);
  expect(search.get('hash')).toBe('101');
  expect(search.has('tab')).toBe(false);
  expect(search.get('show')).toBe('all');
});
