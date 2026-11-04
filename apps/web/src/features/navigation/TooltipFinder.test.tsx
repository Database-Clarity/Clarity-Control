// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { FinderSheetContext } from './FinderSheetContext';
import { TooltipNavigation } from './TooltipNavigation';

const item = (hash: number, name: string, categoryId: string, extra = {}) => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...extra,
});
const data = {
  categories: [
    { id: 'armor', label: 'Armor', group: 'Gear', order: 1 },
    { id: 'weapons', label: 'Weapons', group: 'Gear', order: 2 },
  ],
  items: {
    10: item(10, 'Alpha helm', 'armor'),
    11: item(11, 'Beta helm', 'armor', { owners: [30, 31] }),
    12: item(12, 'Gamma helm', 'armor'),
    20: item(20, 'Delta rifle', 'weapons'),
    21: item(21, 'Epsilon rifle', 'weapons'),
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

let host: HTMLDivElement;
let root: Root;
const originalDrafts = useDraftStore.getState();

function Echo() {
  const location = useLocation();
  return <output data-route="">{`${location.pathname}${location.search}`}</output>;
}
async function mount(path = '/t/10?lang=de', source: EditorData = data) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/t/:hash"
            element={
              <>
                <TooltipNavigation data={source} />
                <Echo />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const route = () => host.querySelector('[data-route]')!.textContent;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => void field().dispatchEvent(event));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return event;
}
const open = () => act(async () => field().click());

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDraftStore.setState({ drafts: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDraftStore.setState(originalDrafts);
});

describe('tooltip finder combobox', () => {
  it('lets the phone sheet step itself but blocks an unrelated modal before landing', async () => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/t/10']}>
          <div data-shell-overlay="Find" role="dialog" aria-modal="true">
            <FinderSheetContext.Provider value={true}>
              <TooltipNavigation data={data} variant="sheet" />
            </FinderSheetContext.Provider>
          </div>
          <Echo />
        </MemoryRouter>,
      ),
    );
    const next = () => host.querySelector<HTMLButtonElement>('[aria-label="Next tooltip"]')!;
    await act(async () => next().click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(route()).toBe('/t/11');
    const modal = document.createElement('dialog');
    modal.setAttribute('open', '');
    document.body.append(modal);
    try {
      await act(async () => next().click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(route()).toBe('/t/11');
    } finally {
      modal.remove();
    }
  });
  it('windows a large category while keeping End and its active descendant usable', async () => {
    const many = {
      ...data,
      items: Object.fromEntries(
        Array.from({ length: 800 }, (_, i) => [
          1000 + i,
          item(1000 + i, `Armor ${String(i).padStart(3, '0')}`, 'armor'),
        ]),
      ),
    } as EditorData;
    await mount('/t/1000', many);
    await open();
    expect(options().length).toBeLessThan(220);
    await press('End');
    const active = host.querySelector(`[id="${field().getAttribute('aria-activedescendant')}"]`);
    expect(active?.textContent).toContain('Armor 799');
    expect(active?.getAttribute('aria-posinset')).toBe('800');
    expect(active?.getAttribute('aria-setsize')).toBe('800');
    // Fill the destination viewport before paint, not only the active row
    // isolated after a spacer while waiting for the next scroll event.
    expect(options().some((row) => row.textContent?.includes('Armor 798'))).toBe(true);
    expect(host.querySelector<HTMLElement>('[role="listbox"]')!.scrollTop).toBeGreaterThan(0);
    await press('Home');
    expect(host.querySelector<HTMLElement>('[role="listbox"]')!.scrollTop).toBe(0);
    await press('End');
    await press('Enter');
    expect(route()).toBe('/t/1799');
  });
  it.each(['pointerup', 'pointercancel'])(
    'covers a whole-category thumb jump until %s restores the landed window',
    async (release) => {
      const many = {
        ...data,
        items: Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [
            1000 + i,
            item(1000 + i, `Armor ${String(i).padStart(3, '0')}`, 'armor'),
          ]),
        ),
      } as EditorData;
      await mount('/t/1000', many);
      await open();
      const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
      Object.defineProperties(list, {
        clientWidth: { value: 200 },
        clientHeight: { value: 416 },
      });
      const lastRow = options().find((row) => row.textContent?.includes('Armor 399'));
      expect(lastRow).toBeDefined();
      const down = new MouseEvent('pointerdown', { button: 0, bubbles: true });
      Object.defineProperty(down, 'offsetX', { value: 207 });
      await act(async () => void list.dispatchEvent(down));
      expect(options()).toHaveLength(400);
      // A thumb may traverse all overscan in one packet; its destination is
      // already mounted before the asynchronous scroll notification arrives.
      list.scrollTop = 9800;
      await act(async () => void list.dispatchEvent(new Event('scroll')));
      expect(options()).toHaveLength(400);
      await act(async () => void window.dispatchEvent(new Event(release)));
      expect(options()).toHaveLength(400);
      expect(options().find((row) => row.textContent?.includes('Armor 399'))).toBe(lastRow);
      expect(list.hasAttribute('data-scrollbar-drag')).toBe(false);
      expect(list.hasAttribute('data-scrollbar-surface')).toBe(true);
      expect(route()).toBe('/t/1000');
      await press('Escape');
      await open();
      expect(host.querySelector('[role="listbox"]')!.hasAttribute('data-scrollbar-surface')).toBe(
        false,
      );
    },
  );
  it('marks only a real base -> enhanced pair with the gold arrow, and a search for the variant lands on the base', async () => {
    const variants = {
      ...data,
      categories: [
        { id: 'armor', label: 'Armor', group: 'Gear', order: 1, legacyType: 'Weapon Trait' },
        {
          id: 'armor-e',
          label: 'Armor E',
          group: 'Gear',
          order: 3,
          legacyType: 'Weapon Trait Enhanced',
        },
        { id: 'weapons', label: 'Weapons', group: 'Gear', order: 2, legacyType: 'Weapon Perk' },
      ],
      items: {
        ...data.items,
        13: item(13, 'Alpha helm enhanced', 'armor-e', { baseHash: 10 }),
        // A same-type copy (weapon-perk duplicate, exotic frame, origin trait): a variant, not an enhanced version.
        22: item(22, 'Delta rifle copy', 'weapons', { baseHash: 20 }),
      },
    } as unknown as EditorData;
    await mount('/t/10', variants);
    await open();
    const marks = options().map((row) => row.querySelector('small span svg') !== null);
    // One entry per base: only the base with an enhanced version is marked, and nothing says "+E".
    expect(marks).toEqual([true, false, false]);
    expect(options()[0].textContent).not.toContain('+E');
    expect(options()[0].querySelector('small span')?.getAttribute('title')).toBe(
      'Has an enhanced version',
    );
    await type('enhanced');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Alpha helm');
    await press('Enter');
    expect(route()).toBe('/t/10');
  });

  it('does not mark a same-type copy (weapon-perk duplicate, exotic frame, origin trait)', async () => {
    const variants = {
      ...data,
      categories: [
        { id: 'armor', label: 'Armor', group: 'Gear', order: 1, legacyType: 'Weapon Trait' },
        { id: 'weapons', label: 'Weapons', group: 'Gear', order: 2, legacyType: 'Weapon Perk' },
      ],
      items: { ...data.items, 22: item(22, 'Delta rifle copy', 'weapons', { baseHash: 20 }) },
    } as unknown as EditorData;
    await mount('/t/20', variants);
    await open();
    expect(options().map((row) => row.querySelector('small svg') !== null)).toEqual([false, false]);
  });

  it('shows the current item, the category and the position, with the list closed', async () => {
    await mount();
    expect(field().value).toBe('Alpha helm');
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!.value).toBe(
      'armor',
    );
    expect(host.textContent).toContain('1 of 3');
  });

  it('opens on click with the current category, and tells the selected option from the highlighted one', async () => {
    await mount('/t/11');
    await open();
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Alpha helm'),
      expect.stringContaining('Beta helm'),
      expect.stringContaining('Gamma helm'),
    ]);
    // The list opens on the current item: selected and highlighted.
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[1].id);
    await press('ArrowDown');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[2].id);
    expect(options()[2].hasAttribute('data-active')).toBe(true);
    // Selection (the open item) is a separate mark from the highlight.
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(options()[1].hasAttribute('data-active')).toBe(false);
    expect(options()[2].getAttribute('aria-selected')).toBe('false');
  });

  it('filters while typing, highlights the first match, and Enter commits it', async () => {
    await mount();
    await open();
    await type('gam');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Gamma helm');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await press('Enter');
    expect(route()).toBe('/t/12?lang=de');
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(field().value).toBe('Gamma helm');
  });

  it('matches hashes too', async () => {
    await mount();
    await open();
    await type('12');
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Gamma helm')]);
  });

  it('wraps the highlight with the arrows and Home/End jump while the query is empty', async () => {
    await mount();
    await open();
    await press('ArrowUp');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[2].id);
    await press('ArrowDown');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await press('End');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[2].id);
    await press('Home');
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  it('Escape restores the current item and its (empty) query, and keeps focus in the field', async () => {
    await mount();
    field().focus();
    await open();
    await type('gam');
    expect(field().value).toBe('gam');
    const escape = await press('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(field().value).toBe('Alpha helm');
    expect(document.activeElement).toBe(field());
    expect(route()).toBe('/t/10?lang=de');
    // Opening again starts from an empty query.
    await open();
    expect(options()).toHaveLength(3);
  });

  it('clicking an option commits it without taking focus from the field', async () => {
    await mount();
    field().focus();
    await open();
    const target = options().find((o) => o.textContent?.includes('Beta helm'))!;
    expect(
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
    ).toBe(false);
    await act(async () => target.click());
    expect(route()).toBe('/t/11?lang=de');
  });

  it('says why a search is empty and widens to every category on request', async () => {
    await mount();
    await open();
    await type('rifle');
    expect(options()).toHaveLength(0);
    expect(host.textContent).toContain('No tooltips match “rifle” in Armor.');
    const widen = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Search all categories',
    )!;
    await act(async () => widen.click());
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Delta rifle'),
      expect.stringContaining('Epsilon rifle'),
    ]);
    expect(options()[0].textContent).toContain('Weapons');
    await press('ArrowDown');
    await press('Enter');
    expect(route()).toBe('/t/21?lang=de');
    // The category follows the item.
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!.value).toBe(
      'weapons',
    );
  });

  it('Enter on an empty result searches all categories instead of doing nothing', async () => {
    await mount();
    await open();
    await type('epsilon');
    expect(options()).toHaveLength(0);
    await press('Enter');
    expect(options()).toHaveLength(1);
    await press('Enter');
    expect(route()).toBe('/t/21?lang=de');
  });

  it('marks tooltips with a local draft in the list and on the field', async () => {
    const base = { hash: 12, text: {}, associated: [] };
    useDraftStore.setState({ drafts: { 12: { base, next: { ...base, associated: [1] } } } });
    await mount();
    await open();
    const gamma = options().find((o) => o.textContent?.includes('Gamma helm'))!;
    expect(gamma.textContent).toContain('*');
    expect(gamma.textContent).toContain('Unsaved draft');
    expect(host.querySelector('[aria-label="Unsaved draft"]')).toBeNull();
    await press('Escape');
    useDraftStore.setState({ drafts: { 10: { base, next: base } } });
    await act(async () => {});
    expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
  });

  it('keeps the shared-perk label on the option and the field', async () => {
    await mount('/t/11');
    expect(field().title).toMatch(/Shared perk — used on:/);
    await open();
    const beta = options().find((o) => o.textContent?.includes('Beta helm'))!;
    expect(beta.title).toMatch(/Shared perk/);
    expect(beta.textContent).toContain('shared perk');
  });

  it('closed, the arrow keys still step through the category and stop at its ends', async () => {
    await mount();
    await press('ArrowDown');
    expect(route()).toBe('/t/11?lang=de');
    await press('ArrowDown');
    expect(route()).toBe('/t/12?lang=de');
    await press('ArrowDown');
    expect(route()).toBe('/t/12?lang=de');
    expect(field().value).toBe('Gamma helm');
  });

  it('changing the category opens its first tooltip', async () => {
    await mount();
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
    await act(async () => {
      select.value = 'weapons';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(route()).toBe('/t/20?lang=de');
  });

  it('adds one compact ‹ position › row in the phone sheet form only', async () => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/t/10']}>
          <TooltipNavigation data={data} variant="sheet" />
        </MemoryRouter>,
      ),
    );
    const row = host.querySelector('[aria-label="Step within category"]')!;
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Previous tooltip',
      'Next tooltip',
    ]);
    expect(buttons[0].disabled).toBe(true);
    expect(row.textContent).toBe('‹1 of 3›');
  });
});

describe('finder sheet form', () => {
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/t/11']}>
          <FinderSheetContext.Provider value={open}>
            <TooltipNavigation data={data} variant="sheet" />
          </FinderSheetContext.Provider>
        </MemoryRouter>,
      ),
    );
  it('opens its list with the sheet, field first, and starts clean when the sheet closes', async () => {
    await render(false);
    expect(field().getAttribute('aria-expanded')).toBe('false');
    await render(true);
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(options()).toHaveLength(3);
    expect(host.querySelector('section')!.firstElementChild).toBe(
      field().closest('[class*="combo"]'),
    );
    await type('gam');
    expect(options()).toHaveLength(1);
    await render(false);
    expect(field().getAttribute('aria-expanded')).toBe('false');
    await render(true);
    expect(options()).toHaveLength(3);
  });
});

describe('finder wheel stepping', () => {
  it('a plain wheel over the closed field steps; over the open list it does not', async () => {
    await mount();
    const wheel = async (target: Element) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
      await act(async () => void target.dispatchEvent(event));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      return event;
    };
    const closed = await wheel(field());
    expect(closed.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/11?lang=de');
    await open();
    const whileOpen = await wheel(field());
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/11?lang=de');
  });
});
