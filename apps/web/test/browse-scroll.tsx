import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { Layout } from '../src/features/navigation/Layout';
import styles from '../src/features/navigation/Layout.module.scss';
import { TooltipPage } from '../src/features/tooltip/TooltipPage';
import { ReviewPage } from '../src/features/review/ReviewPage';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import { useCompendiumStore } from '../src/features/compendium/store';
import { useSidebarQueueStore } from '../src/features/navigation/sidebarQueue';
import '../src/ui/global.scss';

const params = new URLSearchParams(window.location.search);
const workspace = params.get('workspace') ?? 'review';
const longEditor = params.get('long') === 'true';
const network: string[] = [];
window.fetch = async (input) => {
  network.push(String(input));
  throw new Error('Network blocked by read-only Browse regression fixture');
};
const timestamp = '2026-11-01T00:00:00Z';
const tooltips: Record<number, Tooltip> = {};
const items: EditorData['items'] = {};
for (let hash = 100; hash < 160; hash++) {
  tooltips[hash] = {
    hash,
    associated: [],
    text: {
      en: {
        text: 'Representative English tooltip mechanics. '.repeat(5),
        updatedAt: timestamp,
        updatedBy: 'fixture',
      },
    },
  };
  items[hash] = {
    hash,
    name: `Sample ${hash}`,
    icon: '',
    categoryId: 'fixture',
    inGameDescription: 'Read-only synthetic tooltip',
  };
}
items[100].itemHash = 900;
items[100].itemName = 'Synthetic exotic owner';
if (longEditor) {
  // A long shared-owner note makes the real Editor sidebar exceed both
  // phone heights without drafts, extra scrollers or test-only CSS.
  items[100].owners = Array.from({ length: 100 }, (_, i) => 900 + i);
  items[100].ownerNames = Object.fromEntries(
    items[100].owners.map((hash) => [hash, `Synthetic exotic owner ${hash} with a long name`]),
  );
}
const data: EditorData = {
  categories: [{ id: 'fixture', label: 'Synthetic category', group: 'Fixture', order: 1 }],
  items,
  aliases: {},
  bundle: {
    sourceCommit: 'synthetic-browse-scroll',
    generatedAt: timestamp,
    tooltips,
    permissions: { users: {} },
    pushed: {},
  },
};
useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
useAuthStore.setState({ user: null, loading: false, error: null, load: async () => {} });
useDraftStore.setState({
  drafts: {},
  hydrated: true,
  pending: 0,
  error: null,
  hydrate: async () => {},
});
useCompendiumStore.setState({
  data: { fetchedAt: timestamp, tabs: [] },
  loading: false,
  error: null,
  load: async () => {},
});
useSidebarQueueStore.setState({
  compendiumCategories: Array.from({ length: 44 }, (_, i) => ({
    id: `fixture-category-${i}`,
    name: `Synthetic category ${i}: a deliberately long category name for wrapping`,
  })),
  pendingChanges: null,
});
const path =
  workspace === 'editor'
    ? '/t/100?lang=de'
    : workspace === 'compendium'
      ? '/compendium?group=fixture-category-18'
      : '/review?hash=105';
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route element={<Layout />}>
        <Route path="t/:hash" element={<TooltipPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route
          path="compendium"
          element={
            <article>
              <h1>Synthetic Compendium queue</h1>
              <p>In-memory categories only; no matching or guidance actions.</p>
            </article>
          }
        />
      </Route>
    </Routes>
  </MemoryRouter>,
);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < deadline, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function rect(element: Element) {
  const { x, y, width, height, bottom } = element.getBoundingClientRect();
  return { x, y, width, height, bottom };
}

async function run() {
  await waitFor(
    () =>
      workspace === 'review'
        ? document.querySelectorAll('[aria-label="Pending saved changes"] li a').length === 60
        : document.querySelector('#main-content article') !== null,
    'workspace queue',
  );
  const sidebar = document.getElementById('sidebar')!;
  const body = sidebar.querySelector<HTMLElement>(`.${styles.sidebarBody}`)!;
  const close = sidebar.querySelector<HTMLButtonElement>('[aria-controls="sidebar"]')!;
  const main = document.getElementById('main-content')!;
  const selected = () =>
    sidebar.querySelector('a[aria-current="page"]')?.getAttribute('href') ??
    sidebar.querySelector<HTMLSelectElement>('[aria-describedby="tooltip-stepping-help"]')?.value;
  const beforeSelection = selected();
  if (window.innerWidth > 700) {
    const anchor = sidebar.querySelector('li a');
    const density = anchor ? getComputedStyle(anchor) : null;
    if (density) {
      assert(density.minHeight === '0px', 'Phone target minimum leaked to desktop');
      assert(density.display === 'block', 'Desktop queue display changed');
      assert(Math.abs(parseFloat(density.paddingTop) - 5.6) < 0.01, 'Desktop padding changed');
    }
    return {
      desktop: true,
      viewport: [innerWidth, innerHeight],
      body: rect(body),
      anchor: anchor ? rect(anchor) : null,
      minHeight: density?.minHeight,
      padding: density?.paddingTop,
      network,
    };
  }
  if (workspace === 'editor' && !longEditor) {
    return { representativeEditor: true, viewport: [innerWidth, innerHeight], network };
  }
  const beforeScroll = window.scrollY;
  close.click();
  await waitFor(() => sidebar.getAttribute('role') === 'dialog', 'Browse opens');
  assert(document.activeElement === close, 'Close must receive focus');
  const last = body
    .querySelectorAll<HTMLAnchorElement>('a[href]')
    .item(body.querySelectorAll('a[href]').length - 1);
  assert(last !== null, 'Missing final actionable link');
  const queueLinks = body.querySelectorAll('nav li a');
  const lastQueue = queueLinks.item(queueLinks.length - 1);
  const measure = () => ({
    viewport: [innerWidth, innerHeight],
    body: rect(body),
    clientHeight: body.clientHeight,
    scrollHeight: body.scrollHeight,
    scrollTop: body.scrollTop,
    close: rect(close),
    last: rect(last),
    lastQueue: lastQueue ? rect(lastQueue) : null,
    scrollY: window.scrollY,
    documentWidth: document.documentElement.scrollWidth,
  });
  const top = measure();
  assert(top.body.bottom <= innerHeight + 1, `Clipped body: ${JSON.stringify(top)}`);
  assert(top.close.y >= 0 && top.close.bottom <= innerHeight, 'Close is off-screen');
  assert(body.scrollHeight > body.clientHeight, 'Long body must overflow internally');
  for (const anchor of body.querySelectorAll('nav a')) {
    const bounds = rect(anchor);
    assert(bounds.width >= 44 && bounds.height >= 44, 'Queue target below 44px');
  }
  body.scrollTop = body.scrollHeight;
  const end = measure();
  assert(end.scrollTop > 100, `List did not scroll: ${JSON.stringify(end)}`);
  assert(end.last.y >= end.body.y - 1, 'Last link above the scroll viewport');
  assert(end.last.bottom <= end.body.bottom + 1, 'Last link clipped at end');
  if (end.lastQueue) {
    assert(end.lastQueue.y >= end.body.y - 1, 'Last queue link above the scroll viewport');
    assert(end.lastQueue.bottom <= end.body.bottom + 1, 'Last queue link clipped at end');
  }
  assert(end.close.y === top.close.y, 'Close moved with the list');
  assert(window.scrollY === beforeScroll, 'Background scrolled');
  assert(end.documentWidth === innerWidth, 'Horizontal page overflow');
  const scrollers = [...sidebar.querySelectorAll<HTMLElement>('*')].filter((element) => {
    const overflow = getComputedStyle(element).overflowY;
    return /auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 1;
  });
  assert(scrollers.length === 1 && scrollers[0] === body, 'Expected one bounded scroll body');
  close.focus();
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
  );
  assert(document.activeElement === last, 'Shift+Tab did not wrap to the final link');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  assert(document.activeElement === close, 'Tab did not wrap back to Close');
  for (const key of ['a', 's', 'n', 'p', 'u', 'ArrowDown', 'ArrowUp']) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  window.dispatchEvent(
    new WheelEvent('wheel', { shiftKey: true, deltaY: 100, bubbles: true, cancelable: true }),
  );
  assert(sidebar.getAttribute('role') === 'dialog', 'Background shortcut closed Browse');
  assert(selected() === beforeSelection, 'Background shortcut changed selection');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => sidebar.getAttribute('role') === null, 'Escape closes Browse');
  assert(document.activeElement === close, 'Escape did not restore opener focus');
  assert(!main.hasAttribute('inert'), 'Background remained inert');
  assert(selected() === beforeSelection, 'Close changed selection');
  close.click();
  await waitFor(() => sidebar.getAttribute('role') === 'dialog', 'Browse reopens');
  body.scrollTop = 0;
  assert(selected() === beforeSelection, 'Reopen changed selection');
  assert(network.length === 0, `Unexpected fixture requests: ${network.join(', ')}`);
  assert(Object.keys(useDraftStore.getState().drafts).length === 0, 'Fixture created drafts');
  return { top, end, selected: beforeSelection, network };
}

void run().then(
  (measurements) => {
    document.getElementById('result')!.textContent = `PASS ${JSON.stringify(measurements)}`;
  },
  (error: unknown) => {
    document.getElementById('result')!.textContent =
      `FAIL ${error instanceof Error ? error.stack : String(error)}`;
  },
);
