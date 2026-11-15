// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useBlocker,
  useLocation,
} from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Marks } from '@clarity/core/marks';
import { useDataStore, type EditorData } from '../../stores/data';
import { useQueueDone, useWorkThrough } from '../queue/useQueue';
import { WorkThroughControl } from '../queue/QueueControl';
import { resetWorkQueues, useWorkQueues } from '../queue/store';
import type { WorkQueue } from '../queue/model';
import { navigationGroups, groupedSection } from '../navigation/catalog';
import { TooltipNavigation } from '../navigation/TooltipNavigation';
import { picker, pickOption } from '../navigation/finderPicker.testUtils';
import { useMarksStore } from './store';
import { buildMarkedSection, markedRouteCategory, markedScopeValue } from './finder';
import { markedQueueItems, marksQueue } from './source';
import { useAuthStore } from '../../stores/auth';

const at = '2026-11-15T00:00:00Z';
const data: EditorData = {
  categories: [
    { id: 'weapon', label: 'Weapons', group: 'Gear', order: 1 },
    { id: 'armor', label: 'Armor', group: 'Gear', order: 2 },
  ],
  aliases: {},
  items: Object.fromEntries(
    [10, 20, 30].map((hash) => [
      hash,
      {
        hash,
        name: `Entry ${hash}`,
        categoryId: hash === 30 ? 'armor' : 'weapon',
        icon: '',
        inGameDescription: '',
      },
    ]),
  ),
  bundle: {
    sourceCommit: 'a',
    generatedAt: at,
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
  },
};
const marks: Marks = {
  types: [
    { id: 'retest', label: 'Needs retesting', colour: 'amber', by: 1, at },
    { id: 'verify', label: 'Verify values', colour: 'blue', by: 1, at },
  ],
  entries: {
    10: [{ type: 'retest', note: 'Check Arc damage', by: 1, at }],
    30: [
      { type: 'retest', by: 1, at },
      { type: 'verify', by: 1, at },
    ],
  },
};
let host: HTMLDivElement;
let root: Root;
let previousData: EditorData | null;
let blockLeave = false;
function Echo() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}
beforeEach(() => {
  previousData = useDataStore.getState().data;
  useDataStore.setState({ data });
  resetWorkQueues();
  blockLeave = false;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  useMarksStore.getState().accept(structuredClone(marks));
  useAuthStore.setState({ user: null, loading: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useMarksStore.getState().accept({ types: [], entries: {} });
  useDataStore.setState({ data: previousData });
  resetWorkQueues();
  vi.unstubAllGlobals();
});
it('groups marked entries across categories, keeps multiple memberships, and preserves route scope', () => {
  const section = buildMarkedSection(navigationGroups(data, ''), marks)!;
  const grouped = groupedSection(section, data)!;
  expect(
    grouped.groups.map((group) => [group.label, group.entries.map((entry) => entry.hash)]),
  ).toEqual([
    ['Needs retesting', [10, 30]],
    ['Verify values', [30]],
  ]);
  expect(grouped.owners.get(30)).toHaveLength(2);
  expect(markedScopeValue({ hash: 10, group: 'mark.retest' }, true, grouped.firstGroup)).toBe(
    'all:mark.retest',
  );
  expect(markedRouteCategory(10, '?g=all:mark.retest', [section])).toBe('marked');
  expect(markedRouteCategory(20, '?g=mark.retest', [section])).toBeUndefined();
});
it('freezes mark queues, and finishes an item when its mark or type is removed', () => {
  const items = markedQueueItems(data, 'retest');
  expect(items.map((item) => item.hash)).toEqual([10, 30]);
  const done = marksQueue.done({ data, user: null, decisions: {} });
  expect(done(items[0], {})).toBe(false);
  useMarksStore.getState().accept({ ...marks, entries: { 30: marks.entries[30] } });
  expect(items).toHaveLength(2);
  expect(done(items[0], {})).toBe(true);
  expect(done(items[1], {})).toBe(false);
});
it('preserves language for every queue item, and updates completion without a draft change', async () => {
  const items = markedQueueItems(data, 'retest', '?lang=de');
  expect(items.every((item) => item.path?.includes('lang=de'))).toBe(true);
  const queue: WorkQueue = {
    version: 1,
    id: 'marks-test',
    source: 'marks',
    scope: 'shown',
    origin: { path: '/t/10?g=mark.retest', restore: { type: 'retest' } },
    items,
    skipped: [],
    current: items[0].key,
    finished: false,
    createdAt: 0,
    destination: null,
  };
  function Status() {
    const done = useQueueDone(queue);
    return <output>{items.map((item) => (done(item) ? '1' : '0')).join('')}</output>;
  }
  const before = useDataStore.getState().data;
  useDataStore.setState({ data });
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <Status />
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).toBe('00');
    await act(async () =>
      useMarksStore.getState().accept({ ...marks, entries: { 30: marks.entries[30] } }),
    );
    expect(host.textContent).toBe('10');
  } finally {
    useDataStore.setState({ data: before });
  }
});
async function mount(path = '/t/10') {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <TooltipNavigation data={data} />
        <Echo />
      </MemoryRouter>,
    ),
  );
}
async function type(value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('input[role=combobox]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('finds mark labels and notes, and changes category and mark-type scopes', async () => {
  await mount();
  await act(async () => host.querySelector<HTMLInputElement>('input[role=combobox]')!.click());
  await type('Arc damage');
  expect(host.querySelector('[role=listbox]')!.textContent).toContain('Entry 10');
  await type('retest');
  expect(host.querySelector('[role=listbox]')!.textContent).toContain('Entry 10');
  await type('');
  await pickOption(picker(host, 'Category')!, 'marked');
  expect(host.querySelector('output')!.textContent).toContain('g=all:mark.retest');
  await act(async () => host.querySelector<HTMLInputElement>('input[role=combobox]')!.click());
  await pickOption(picker(host, 'Mark type')!, 'mark.retest');
  expect(host.querySelector('output')!.textContent).toContain('g=mark.retest');
  await act(async () => host.querySelector<HTMLInputElement>('input[role=combobox]')!.click());
  expect(host.querySelector('[aria-label="Work through marked entries"]')).not.toBeNull();
});

it('leaves mark grouping lazy on ordinary opening, and builds it on category selection', async () => {
  const stored = useMarksStore.getState().marks;
  const entries = stored.entries;
  const read = vi.fn(() => entries);
  Object.defineProperty(stored, 'entries', { get: read, configurable: true });
  await mount();
  await act(async () => host.querySelector<HTMLInputElement>('input[role=combobox]')!.click());
  expect(read).not.toHaveBeenCalled();
  expect(
    host.querySelector('[role=listbox] [role=img][aria-label="Needs retesting"]'),
  ).not.toBeNull();
  expect(host.querySelector('[role=listbox] button[aria-label="Entry marks"]')).toBeNull();
  await pickOption(picker(host, 'Category')!, 'marked');
  expect(read).toHaveBeenCalled();
  expect(host.querySelector('output')!.textContent).toContain('g=all:mark.retest');
});
it('restores a marked scope directly, and restores ordinary results after clearing search', async () => {
  await mount('/t/30?g=mark.verify');
  expect(picker(host, 'Category')!.getAttribute('data-value')).toBe('marked');
  await act(async () => host.querySelector<HTMLInputElement>('input[role=combobox]')!.click());
  expect(host.querySelector('[role=listbox]')!.textContent).toContain('Entry 30');
  await type('no matching mark or entry');
  expect(host.querySelector('[role=listbox]')!.textContent).not.toContain('Entry 30');
  await type('');
  expect(host.querySelector('[role=listbox]')!.textContent).toContain('Entry 30');
});

function QueueEditor() {
  const location = useLocation();
  useBlocker(() => blockLeave);
  const work = useWorkThrough(location.state);
  return (
    <>
      <TooltipNavigation data={data} />
      {work && <WorkThroughControl work={work} />}
      <Echo />
    </>
  );
}
async function startFilteredQueue(path = '/t/10?g=mark.retest&lang=de') {
  const router = createMemoryRouter([{ path: '/t/:hash', element: <QueueEditor /> }], {
    initialEntries: [path],
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  await type('Arc damage');
  expect(host.querySelector('[role=listbox]')!.textContent).not.toContain('Entry 30');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Work through marked entries"]')!.click(),
  );
  const queue = useWorkQueues.getState().queues[useWorkQueues.getState().active!]!;
  return { router, queue };
}
const leaveLink = () =>
  [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
    (link) => link.textContent === 'Marked entries',
  )!;

it('preserves the queue visit on Back when Work through starts at its origin entry URL', async () => {
  const { router, queue } = await startFilteredQueue('/t/10?g=mark.retest');
  expect(router.state.location.pathname + router.state.location.search).toBe(queue.origin.path);
  await act(async () => leaveLink().click());
  expect(router.state.historyAction).toBe('PUSH');
  expect(useWorkQueues.getState().active).toBeNull();
  await act(async () => router.navigate(-1));
  expect(router.state.location.state.workThrough.id).toBe(queue.id);
  expect(useWorkQueues.getState().active).toBe(queue.id);
  expect(host.querySelector('[data-queue]')).not.toBeNull();
});

it('freezes shown matches, respects a refused Leave, and restores the filter on Leave and Forward', async () => {
  const { router, queue } = await startFilteredQueue();
  expect(queue.items.map((item) => item.hash)).toEqual([10]);
  expect(queue.items.every((item) => item.path?.includes('lang=de'))).toBe(true);
  expect(queue.origin.restore).toMatchObject({ type: 'retest', query: 'Arc damage' });
  blockLeave = true;
  await act(async () => leaveLink().click());
  expect(useWorkQueues.getState().active).toBe(queue.id);
  expect(host.querySelector('[data-queue]')).not.toBeNull();
  blockLeave = false;
  await act(async () => leaveLink().click());
  expect(useWorkQueues.getState().active).toBeNull();
  expect(host.querySelector('[data-queue]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[aria-label=Tooltip]')!.value).toBe(
    'Arc damage',
  );
  expect(host.querySelector('[role=listbox]')!.textContent).not.toContain('Entry 30');
  await act(async () => router.navigate(-1));
  expect(useWorkQueues.getState().active).toBe(queue.id);
  expect(host.querySelector('[data-queue]')).not.toBeNull();
  await act(async () => router.navigate(1));
  expect(useWorkQueues.getState().active).toBeNull();
  expect(host.querySelector('[data-queue]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[aria-label=Tooltip]')!.value).toBe(
    'Arc damage',
  );
});
it('rebuilds with the saved finder query, without changing frozen membership before rebuilding', async () => {
  const { queue } = await startFilteredQueue();
  await act(async () =>
    useMarksStore.getState().accept({
      ...marks,
      entries: {
        ...marks.entries,
        30: [{ ...marks.entries[30][0], note: 'Check Arc damage too' }],
      },
    }),
  );
  expect(queue.items.map((item) => item.hash)).toEqual([10]);
  const rebuilt = await marksQueue.rebuild(queue, { data, user: null, decisions: {} }, {});
  expect(rebuilt.map((item) => item.hash)).toEqual([10, 30]);
  expect(rebuilt[0]).toBe(queue.items[0]);
  expect(rebuilt.every((item) => item.path?.includes('lang=de'))).toBe(true);
  await act(async () => useMarksStore.getState().accept(marks));
  expect(
    (await marksQueue.rebuild(queue, { data, user: null, decisions: {} }, {})).map(
      (item) => item.hash,
    ),
  ).toEqual([10]);
});
it.each([
  ['Needs retesting', [10, 30]],
  ['Arc damage', [10]],
  ['Entry 30', [30]],
  ['no matches', []],
  ['   ', [10, 30]],
])('uses finder text and mark matching when building a queue for %s', (query, hashes) => {
  expect(markedQueueItems(data, 'retest', '', query as string).map((item) => item.hash)).toEqual(
    hashes,
  );
});
