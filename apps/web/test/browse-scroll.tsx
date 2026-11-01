import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { Layout } from '../src/features/navigation/Layout';
import styles from '../src/features/navigation/Layout.module.scss';
import { TooltipPage } from '../src/features/tooltip/TooltipPage';
import { ReviewPage } from '../src/features/review/ReviewPage';
import { MatchReviewPage } from '../src/features/compendium/MatchReviewPage';
import { guidedFixture } from './guided-fixture';
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
const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  },
});
window.fetch = async (input) => {
  network.push(String(input));
  throw new Error('Network blocked by read-only Browse regression fixture');
};
const compendium = guidedFixture();
compendium.editor.categories = [
  { id: 'weapon-trait', label: 'Synthetic friendly weapon traits', group: 'Fixture', order: 1 },
];
const longEvidence = 'Synthetic long evidence stays available below the review controls. '.repeat(
  32,
);
compendium.editor.items[100].inGameDescription = longEvidence;
compendium.source.tabs[0].rows[0].cell = {
  plain: longEvidence,
  runs: [{ text: longEvidence }],
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
const activeData = workspace.startsWith('compendium-') ? compendium.editor : data;
useDataStore.setState({ data: activeData, status: 'ready', error: null, load: async () => {} });
useAuthStore.setState({ user: null, loading: false, error: null, load: async () => {} });
useDraftStore.setState({
  drafts: {},
  hydrated: true,
  pending: 0,
  error: null,
  hydrate: async () => {},
});
useCompendiumStore.setState({
  data: workspace.startsWith('compendium-')
    ? compendium.source
    : { fetchedAt: timestamp, tabs: [] },
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
    : workspace === 'compendium-sample'
      ? '/compendium/review'
      : workspace === 'compendium-entry' && params.get('initial') === 'entries'
        ? '/compendium/review?view=entries&hash=100'
        : workspace === 'compendium-entry'
          ? '/compendium/review'
          : workspace === 'compendium'
            ? '/compendium?group=fixture-category-18'
            : '/review?hash=105';
const root = createRoot(document.getElementById('root')!);
window.addEventListener('review-fixture-unmount', () => root.unmount(), { once: true });
root.render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route element={<Layout />}>
        <Route path="t/:hash" element={<TooltipPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="compendium/review" element={<MatchReviewPage />} />
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

function assert(condition: unknown, message: string): asserts condition {
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

function scrollableAncestors(element: HTMLElement) {
  const scrollables: HTMLElement[] = [];
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const overflow = getComputedStyle(parent).overflowY;
    if (/auto|scroll/.test(overflow) && parent.scrollHeight > parent.clientHeight + 1)
      scrollables.push(parent);
  }
  const page = document.scrollingElement as HTMLElement | null;
  if (page && page.scrollHeight > page.clientHeight + 1 && !scrollables.includes(page))
    scrollables.push(page);
  return scrollables;
}

function assertVisible(element: HTMLElement, description: string) {
  const bounds = rect(element);
  assert(
    bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= innerWidth + 1 &&
      bounds.bottom <= innerHeight + 1,
    `${description} is outside the viewport: ${JSON.stringify(bounds)}`,
  );
  const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  assert(hit === element || element.contains(hit), `${description} is obscured`);
}

function assertActionTargets(buttons: HTMLButtonElement[], description: string) {
  for (const [index, button] of buttons.entries()) {
    const bounds = rect(button);
    assert(
      bounds.width >= 44 && bounds.height >= 44,
      `${description} target ${index + 1} is below 44x44: ${JSON.stringify(bounds)}`,
    );
    assertVisible(button, `${description} target ${index + 1}`);
  }
}

async function nextFrame() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function scrollToEnd(element: HTMLElement) {
  for (const scroller of scrollableAncestors(element)) scroller.scrollTop = scroller.scrollHeight;
  await nextFrame();
}

async function scrollOverlayToEnd(overlay: HTMLElement) {
  const descendants = [...overlay.querySelectorAll<HTMLElement>('*')].reverse();
  for (const element of [...descendants, overlay]) {
    const overflow = getComputedStyle(element).overflowY;
    if (/auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 1)
      element.scrollTop = element.scrollHeight;
  }
  await nextFrame();
}

async function run() {
  let emptyFilter:
    | {
        viewport: number[];
        bounds: ReturnType<typeof rect>;
        resetQuery: string;
        resultCount: string;
      }
    | undefined;
  if (
    workspace === 'compendium-entry' &&
    params.get('initial') !== 'entries' &&
    !document.querySelector('footer[aria-label="Review actions"]')
  ) {
    await waitFor(
      () => document.querySelector('[aria-label="Category guidance"]') !== null,
      'initial category mount',
    );
    const review = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Review all one by one',
    );
    assert(review, 'Missing category-to-entry action');
    review.click();
  }
  await waitFor(
    () =>
      workspace === 'review'
        ? document.querySelectorAll('[aria-label="Pending saved changes"] li a').length === 60
        : workspace === 'compendium-entry'
          ? document.querySelector('footer[aria-label="Review actions"]') !== null &&
            [...document.querySelectorAll('button')].some(
              (button) => button.textContent?.trim() === 'Bulk preview (6)',
            )
          : workspace === 'compendium-sample'
            ? document.querySelector('[aria-label="Category guidance"]') !== null &&
              document.querySelector('[aria-label="Sample proposed source"] h3')?.textContent ===
                'Proposed source'
            : document.querySelector('#main-content article') !== null,
    'workspace queue',
  );
  if (workspace.startsWith('compendium-')) {
    await document.fonts.ready;
    let previousHeight = document.documentElement.scrollHeight;
    let stableFrames = 0;
    for (let frame = 0; frame < 60 && stableFrames < 5; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const currentHeight = document.documentElement.scrollHeight;
      stableFrames = currentHeight === previousHeight ? stableFrames + 1 : 0;
      previousHeight = currentHeight;
    }
    assert(stableFrames === 5, 'Compendium layout did not settle after matching');
    const sample = workspace === 'compendium-sample';
    const firstAction = document.querySelector<HTMLElement>(
      sample ? '[aria-label^="Resolve sample"] button' : 'footer[aria-label="Review actions"]',
    )!;
    const actionRegion = sample ? firstAction.parentElement! : firstAction;
    const consequence = actionRegion.querySelector('p')?.textContent?.trim() ?? '';
    assert(
      consequence ===
        (sample
          ? 'Saves as example · no tooltip change'
          : 'Links create local drafts, not saves · Skip/No equivalent stay in browser.'),
      'Decision consequence must appear inside its action region',
    );
    const actionButtons = [...actionRegion.querySelectorAll<HTMLButtonElement>('button')];
    const expectedActionCount = sample ? 4 : 5;
    assert(
      actionButtons.length === expectedActionCount,
      `Expected ${expectedActionCount} existing decision actions`,
    );
    const actionMeasurements: {
      phase: string;
      actions: ReturnType<typeof rect>;
      buttons: ReturnType<typeof rect>[];
    }[] = [];
    const evidence = document.querySelectorAll<HTMLElement>('[aria-label="Entry to review"] pre');
    const categoryInputs = document.querySelectorAll<HTMLTextAreaElement>(
      '[aria-label="Category guidance"] textarea',
    );
    const target = sample
      ? categoryInputs.item(categoryInputs.length - 1)
      : evidence.item(evidence.length - 1);
    assert(target !== null, 'Missing final sample input or review evidence');
    if (innerWidth <= 700) {
      const position = getComputedStyle(actionRegion).position;
      assert(
        position === (sample ? 'sticky' : 'fixed'),
        'Phone decision actions must remain reachable',
      );
    }
    async function measureSample(phase: string) {
      assert(target, 'Missing final category input');
      if (innerWidth > 700) {
        await scrollToEnd(target);
        assertActionTargets(actionButtons, `Sample ${phase} actions`);
        assertVisible(target, `Sample ${phase} LAST category input`);
        actionMeasurements.push({
          phase: `${phase}-full-scroll-end`,
          actions: rect(actionRegion),
          buttons: actionButtons.map(rect),
        });
        return;
      }
      const page = document.scrollingElement as HTMLElement;
      page.scrollTop = 0;
      await nextFrame();
      const maxScroll = page.scrollHeight - page.clientHeight;
      const actionBottom = actionRegion.getBoundingClientRect().bottom + page.scrollTop;
      const firstActionScroll = Math.min(maxScroll, Math.max(0, actionBottom - innerHeight));
      const positions = [
        firstActionScroll,
        ...[0.25, 0.5, 0.75].map((fraction) =>
          Math.floor(firstActionScroll + (maxScroll - firstActionScroll) * fraction),
        ),
        maxScroll,
      ];
      for (const [index, scrollTop] of positions.entries()) {
        page.scrollTop = scrollTop;
        await nextFrame();
        assertActionTargets(
          actionButtons,
          `Sample ${phase} actions at scroll position ${index + 1}`,
        );
        const actionBounds = rect(actionRegion);
        const targetBounds = rect(target);
        if (targetBounds.bottom > 0 && targetBounds.y < innerHeight) {
          assert(
            targetBounds.bottom <= actionBounds.y + 1 || targetBounds.y >= actionBounds.bottom - 1,
            `Final sample input overlaps its action bar: ${JSON.stringify({ targetBounds, actionBounds })}`,
          );
        }
        actionMeasurements.push({
          phase: `${phase}-document-${page.scrollTop}-of-${maxScroll}`,
          actions: actionBounds,
          buttons: actionButtons.map((button) => rect(button)),
        });
      }
      assert(page.scrollTop === maxScroll, 'Sample fixture did not reach the full document end');
      assertVisible(target, `Sample ${phase} LAST category input`);
      const sampleInputs = document.querySelectorAll<HTMLTextAreaElement>(
        '[aria-label^="Resolve sample"] textarea',
      );
      const lastSampleInput = sampleInputs.item(sampleInputs.length - 1);
      assert(lastSampleInput, 'Missing final sample note');
      assertVisible(lastSampleInput, `Sample ${phase} final sample note`);
    }
    if (sample) {
      await measureSample('closed');
      const pick = actionButtons.find((button) => button.textContent?.trim() === 'Pick other');
      assert(pick, 'Missing sample Pick other action');
      pick.click();
      await waitFor(
        () =>
          [...document.querySelectorAll('[aria-label^="Resolve sample"] button')].some(
            (button) => button.textContent?.trim() === 'Close picker',
          ),
        'actual sample picker expands',
      );
      await measureSample('expanded');
    } else {
      target.scrollIntoView({ block: 'end' });
      await nextFrame();
      const targetBounds = rect(target);
      const actionBounds = rect(actionRegion);
      if (targetBounds.bottom > actionBounds.y && targetBounds.y < actionBounds.bottom) {
        const scroller =
          scrollableAncestors(target)[0] ?? (document.scrollingElement as HTMLElement);
        scroller.scrollTop += targetBounds.bottom - actionBounds.y;
        await nextFrame();
      }
      assertActionTargets(actionButtons, 'Entry actions while final evidence is reachable');
      actionMeasurements.push({
        phase: 'final-evidence-reachable',
        actions: rect(actionRegion),
        buttons: actionButtons.map((button) => rect(button)),
      });
    }
    const finalTarget = rect(target);
    assert(
      finalTarget.bottom > 0 && finalTarget.y < innerHeight,
      'Final evidence/input is not reachable at the full-scroll endpoint',
    );
    const finalActionBounds = rect(actionRegion);
    assert(
      finalTarget.bottom <= finalActionBounds.y + 1 ||
        finalTarget.y >= finalActionBounds.bottom - 1,
      `Final evidence/input overlaps its action bar: ${JSON.stringify({ finalTarget, finalActionBounds })}`,
    );
    assert(
      document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      'Horizontal page overflow',
    );
    assert(
      network.every((url) => url.includes('__review-guidance')),
      'Unexpected fixture request',
    );
    let overlays: Record<string, unknown> | undefined;
    if (!sample) {
      async function measureOverlays() {
        const footer = document.querySelector<HTMLElement>('footer[aria-label="Review actions"]')!;
        const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button')];
        assertActionTargets(buttons, 'Current footer actions before opening overlays');
        const page = footer.closest<HTMLElement>('article')!;
        const measuredHeight = Number.parseFloat(
          getComputedStyle(page).getPropertyValue('--review-action-bar-height'),
        );
        assert(
          Number.isFinite(measuredHeight) &&
            Math.abs(measuredHeight - footer.getBoundingClientRect().height) < 1,
          'Overlay reservation must match the measured action bar height',
        );

        const pick = [...footer.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
          button.textContent?.trim().startsWith('Pick other'),
        )!;
        pick.click();
        await waitFor(
          () => document.querySelector('[aria-label="Pick another source"]') !== null,
          'picker opens',
        );
        const picker = document.querySelector<HTMLElement>('[aria-label="Pick another source"]')!;
        await scrollOverlayToEnd(picker);
        const pickerButtons = [...picker.querySelectorAll<HTMLButtonElement>('button')];
        const pickerLastButton = pickerButtons.at(-1)!;
        const pickerContent =
          picker.querySelector<HTMLElement>('[aria-label="Pick description cells"]') ??
          picker.querySelector<HTMLElement>('[aria-label="Link a Compendium row"]');
        assert(pickerContent, 'Missing actual picker content');
        const pickerLastContent = pickerContent.lastElementChild as HTMLElement;
        const footerBounds = rect(footer);
        const pickerBounds = rect(picker);
        const pickerContentBounds = rect(pickerLastContent);
        assert(
          pickerBounds.bottom <= footerBounds.y + 1,
          `Picker extends behind the review actions: ${JSON.stringify({ pickerBounds, footerBounds })}`,
        );
        assertVisible(pickerLastButton, 'Final picker control');
        assertVisible(pickerLastContent, 'Final picker evidence');
        assertActionTargets(buttons, 'Current footer actions with picker open');
        assert(
          pickerContentBounds.bottom <= footerBounds.y + 1 &&
            pickerContentBounds.bottom > pickerBounds.y - 1,
          `Final picker evidence is not visible above the action bar: ${JSON.stringify({ pickerContentBounds, pickerBounds, footerBounds })}`,
        );
        const pickerResult = {
          viewport: [innerWidth, innerHeight],
          scrollTop: picker.scrollTop,
          maxScroll: picker.scrollHeight - picker.clientHeight,
          overlay: pickerBounds,
          finalContent: pickerContentBounds,
          finalControl: rect(pickerLastButton),
          footer: footerBounds,
        };
        picker.querySelector<HTMLButtonElement>('header button')?.click();
        await waitFor(
          () => document.querySelector('[aria-label="Pick another source"]') === null,
          'picker closes without a decision',
        );

        const bulkButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent?.trim() === 'Bulk preview (6)',
        )!;
        bulkButton.click();
        await waitFor(
          () => document.querySelector('[aria-label="Bulk accept preview"]') !== null,
          'bulk preview opens',
        );
        const bulk = document.querySelector<HTMLElement>('[aria-label="Bulk accept preview"]')!;
        await scrollOverlayToEnd(bulk);
        const bulkFooterBounds = rect(footer);
        const bulkBounds = rect(bulk);
        const bulkButtons = [...bulk.querySelectorAll<HTMLButtonElement>('button')];
        const bulkLastButton = bulkButtons.at(-1)!;
        const bulkList = [...bulk.children].find(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            [...child.children].some((entry) => entry.tagName === 'SECTION'),
        );
        const bulkLastEntry = bulkList?.lastElementChild as HTMLElement | undefined;
        const bulkLastEvidence = bulkLastEntry?.lastElementChild as HTMLElement | undefined;
        assert(
          bulkBounds.bottom <= bulkFooterBounds.y + 1,
          `Bulk preview extends behind the review actions: ${JSON.stringify({ bulkBounds, bulkFooterBounds })}`,
        );
        assertVisible(bulkLastButton, 'Final bulk control');
        assertActionTargets(buttons, 'Current footer actions with bulk open');
        assert(
          !!bulkLastEvidence &&
            rect(bulkLastEvidence).bottom <= bulkFooterBounds.y + 1 &&
            rect(bulkLastEvidence).bottom > bulkBounds.y - 1,
          `Final bulk evidence is not visible above the action bar: ${JSON.stringify({ evidence: bulkLastEvidence ? rect(bulkLastEvidence) : null, bulkBounds, bulkFooterBounds })}`,
        );
        const measurements = {
          actions: rect(footer),
          buttons: buttons.map(rect),
          picker: pickerResult,
          bulk: {
            viewport: [innerWidth, innerHeight],
            scrollTop: bulk.scrollTop,
            maxScroll: bulk.scrollHeight - bulk.clientHeight,
            overlay: bulkBounds,
            finalEvidence: bulkLastEvidence ? rect(bulkLastEvidence) : null,
            finalControl: rect(bulkLastButton),
            footer: bulkFooterBounds,
          },
        };
        assert(
          Object.keys(useDraftStore.getState().drafts).length === 0,
          'Overlay fixture created drafts',
        );
        return measurements;
      }
      const initial = await measureOverlays();
      const bulk = document.querySelector<HTMLElement>('[aria-label="Bulk accept preview"]')!;
      const cancel = [...bulk.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Cancel',
      );
      assert(cancel, 'Missing bulk Cancel');
      cancel.click();
      const oldFooter = document.querySelector<HTMLElement>('footer[aria-label="Review actions"]')!;
      const article = oldFooter.closest<HTMLElement>('article')!;
      const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Back to category guidance',
      );
      assert(back, 'Missing entries-to-category action');
      back.click();
      await waitFor(
        () =>
          document.querySelector('[aria-label="Category guidance"]') !== null &&
          !oldFooter.isConnected,
        'category returns without remounting the fixture',
      );
      await nextFrame();
      assert(
        article.style.getPropertyValue('--review-action-bar-height') === '',
        'Removed footer left a stale reservation',
      );
      const review = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Review all one by one',
      );
      assert(review, 'Missing return to entries');
      review.click();
      await waitFor(
        () => document.querySelector('footer[aria-label="Review actions"]') !== null,
        'replacement footer mounts',
      );
      await nextFrame();
      assert(
        document.querySelector('footer[aria-label="Review actions"]') !== oldFooter,
        'Footer target was not replaced',
      );
      overlays = { initial, replacement: await measureOverlays() };
    }
    return {
      fixture: workspace,
      viewport: [innerWidth, innerHeight],
      actions: rect(
        sample
          ? actionRegion
          : document.querySelector<HTMLElement>('footer[aria-label="Review actions"]')!,
      ),
      consequence,
      actionMeasurements,
      target: finalTarget,
      overlays,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      network,
    };
  }
  if (workspace === 'review') {
    assert(document.querySelectorAll('[role="note"]').length === 1, 'Expected one page notice');
    assert(
      !document.body.textContent?.includes('Sign in to see latest change'),
      'Anonymous sign-in text repeated in pending rows',
    );
    if (innerWidth <= 700) {
      const touchTargets = [
        ...document.querySelectorAll<HTMLElement>(
          '#main-content article button, #main-content article input, #main-content article select',
        ),
      ].filter((target) => target.getBoundingClientRect().height > 0);
      assert(touchTargets.length > 0, 'Missing Review page touch targets');
      assert(
        touchTargets.every((target) => target.getBoundingClientRect().height >= 44),
        'Review action or filter target below 44px',
      );
    }
    const search = document.querySelector<HTMLInputElement>('[aria-label="Find saved changes"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!valueSetter) throw new Error('Input value setter unavailable');
    valueSetter.call(search, 'no-such-fixture-xyz');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(
      () => document.body.textContent?.includes('No saved changes match these filters.') ?? false,
      'empty filtered Review state',
    );
    const clearFilters = [
      ...document.querySelectorAll<HTMLButtonElement>('#main-content article button'),
    ].find((button) => button.textContent?.trim() === 'Clear filters');
    if (!clearFilters) throw new Error('Missing Clear filters action');
    const clearBounds = rect(clearFilters);
    if (innerWidth <= 700)
      assert(
        clearBounds.width >= 44 && clearBounds.height >= 44,
        `Empty-state Clear filters target below 44x44: ${JSON.stringify(clearBounds)}`,
      );
    clearFilters.focus();
    assert(document.activeElement === clearFilters, 'Clear filters must remain keyboard focusable');
    if (params.get('keyboard') === 'true') clearFilters.setAttribute('data-keyboard-ready', '');
    else clearFilters.click();
    await waitFor(
      () =>
        search.value === '' &&
        (document.querySelector('#main-content article')?.textContent ?? '').includes(
          'Showing 60 of 60',
        ),
      'Clear filters resets the actual Review filters',
    );
    if (innerWidth <= 700)
      assert(clearBounds.height >= 44, 'Empty-state Clear filters target below 44px');
    emptyFilter = {
      viewport: [innerWidth, innerHeight],
      bounds: clearBounds,
      resetQuery: search.value,
      resultCount:
        document
          .querySelector('#main-content article')
          ?.textContent?.match(/Showing (\d+ of \d+)/)?.[1] ?? '',
    };
  }
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
      emptyFilter: workspace === 'review' ? emptyFilter : undefined,
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
  return {
    top,
    end,
    selected: beforeSelection,
    emptyFilter: workspace === 'review' ? emptyFilter : undefined,
    network,
  };
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
