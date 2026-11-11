// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { FinderSheetCloseContext, FinderSheetContext } from './FinderSheetContext';
import { TooltipNavigation } from './TooltipNavigation';
import {
  observeNativeDialogShortcutOwner,
  registerWorkspaceShortcutOwner,
} from '../../ui/interaction';

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
async function paintGlobals() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
}
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
  it('opens and sizes from observer entries without forcing list geometry', async () => {
    let resize: ResizeObserverCallback | undefined;
    let observed = false;
    let scrollPosition = 0;
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
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'listbox') throw Error('Forced finder layout');
        return 0;
      });
    const scrollRead = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (
      this: Element,
    ) {
      if (this.getAttribute('role') === 'listbox' && !observed)
        throw Error('Premature scroll geometry');
      return scrollPosition;
    });
    const scrollWrite = vi
      .spyOn(Element.prototype, 'scrollTop', 'set')
      .mockImplementation((value) => {
        scrollPosition = value;
      });
    try {
      await mount();
      await open();
      const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
      observed = true;
      await act(async () => {
        resize!(
          [
            {
              target: list,
              contentRect: new DOMRectReadOnly(0, 0, 100, 28),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          {} as ResizeObserver,
        );
      });
      await press('End');
      await act(async () => {
        resize!(
          [
            {
              target: list,
              contentRect: new DOMRectReadOnly(0, 0, 100, 28),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          {} as ResizeObserver,
        );
      });
      expect(list.scrollTop).toBe(56);
      expect(field().getAttribute('aria-activedescendant')).toBe(options().at(-1)!.id);
    } finally {
      height.mockRestore();
      scrollRead.mockRestore();
      scrollWrite.mockRestore();
      vi.unstubAllGlobals();
    }
  });

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
    const releaseSheet = registerWorkspaceShortcutOwner(
      host.querySelector('[data-shell-overlay]')!,
    );
    const next = () => host.querySelector<HTMLButtonElement>('[aria-label="Next tooltip"]')!;
    await act(async () => next().click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(route()).toBe('/t/11');
    const modal = document.createElement('dialog');
    modal.setAttribute('open', '');
    document.body.append(modal);
    const releaseModal = observeNativeDialogShortcutOwner(modal);
    try {
      await act(async () => next().click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(route()).toBe('/t/11');
    } finally {
      releaseModal();
      modal.remove();
      releaseSheet();
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
    await press('PageDown');
    expect(
      host.querySelector(`[id="${field().getAttribute('aria-activedescendant')}"]`)?.textContent,
    ).toContain('Armor 014');
    expect(route()).toBe('/t/1000');
    await press('PageUp');
    expect(
      host.querySelector(`[id="${field().getAttribute('aria-activedescendant')}"]`)?.textContent,
    ).toContain('Armor 000');
    await press('End');
    await press('Enter');
    expect(route()).toBe('/t/1799');
  });
  it.each(['pointerup', 'pointercancel'])(
    'fills the thumb destination before paint and keeps it through %s',
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
      expect(list.hasAttribute('data-windowed')).toBe(true);
      Object.defineProperties(list, {
        clientWidth: { value: 200 },
        clientHeight: { value: 416 },
      });
      const down = new MouseEvent('pointerdown', { button: 0, bubbles: true });
      Object.defineProperty(down, 'offsetX', { value: 207 });
      await act(async () => void list.dispatchEvent(down));
      expect(options().length).toBeLessThan(160);
      // One native scroll notification fills the jumped-to viewport synchronously.
      list.scrollTop = 9800;
      await act(async () => void list.dispatchEvent(new Event('scroll')));
      expect(options().length).toBeLessThan(160);
      expect(options().some((row) => row.textContent?.includes('Armor 350'))).toBe(true);
      const lastRow = options().find((row) => row.textContent?.includes('Armor 364'));
      expect(lastRow).toBeDefined();
      await act(async () => void window.dispatchEvent(new Event(release)));
      expect(options().length).toBeLessThan(160);
      expect(options().find((row) => row.textContent?.includes('Armor 364'))).toBe(lastRow);
      expect(list.hasAttribute('data-scrollbar-drag')).toBe(false);
      expect(list.hasAttribute('data-windowed')).toBe(true);
      expect(route()).toBe('/t/1000');
      await press('Escape');
      await open();
      expect(host.querySelector('[role="listbox"]')!.hasAttribute('data-windowed')).toBe(true);
    },
  );
  it('fills scroll windows without reconciling the category picker', async () => {
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
    const selected = vi.spyOn(HTMLOptionElement.prototype, 'selected', 'set');
    try {
      const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
      for (const top of [5600, 11200, 16800, 2813, 0]) {
        list.scrollTop = top;
        await act(async () => void list.dispatchEvent(new Event('scroll')));
        const index = Math.floor(top / 28);
        expect(options().some((row) => row.getAttribute('aria-posinset') === `${index + 1}`)).toBe(
          true,
        );
        // Every visible row is filled even after a jump much larger than
        // overscan; offscreen rows must not inflate every scroll commit.
        for (let visible = index; visible < index + (top % 28 ? 16 : 15); visible++) {
          expect(
            options().some((row) => row.getAttribute('aria-posinset') === `${visible + 1}`),
          ).toBe(true);
        }
        expect(options().length).toBeLessThan(36);
      }
      expect(selected).not.toHaveBeenCalled();
      expect(route()).toBe('/t/1000');
      expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    } finally {
      selected.mockRestore();
    }
  });
  it('fills a large thumb destination and commits the landed row', async () => {
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
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    Object.defineProperties(list, { clientWidth: { value: 200 }, clientHeight: { value: 416 } });
    const down = new MouseEvent('pointerdown', { button: 0, bubbles: true });
    Object.defineProperty(down, 'offsetX', { value: 207 });
    await act(async () => void list.dispatchEvent(down));
    expect(options().length).toBeLessThan(160);
    list.scrollTop = 19600;
    await act(async () => void list.dispatchEvent(new Event('scroll')));
    expect(options().some((row) => row.textContent?.includes('Armor 700'))).toBe(true);
    for (let index = 700; index < 715; index++) {
      expect(options().some((row) => row.textContent?.includes(`Armor ${index}`))).toBe(true);
    }
    expect(options().length).toBeLessThan(160);
    expect(list.querySelector<HTMLElement>('[role="presentation"]')!.style.height).toBe('22400px');
    await act(async () => void window.dispatchEvent(new Event('pointerup')));
    expect(options().length).toBeLessThan(220);
    expect(options().some((row) => row.textContent?.includes('Armor 700'))).toBe(true);
    const landed = options().find((row) => row.textContent?.includes('Armor 700'))!;
    expect(landed.getAttribute('aria-posinset')).toBe('701');
    await act(async () => landed.click());
    expect(route()).toBe('/t/1700');
  });
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

describe('finder sheet row choice', () => {
  const close = vi.fn();
  const render = () =>
    act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/t/10?lang=de']}>
          <Routes>
            <Route
              path="/t/:hash"
              element={
                <>
                  <FinderSheetContext.Provider value={true}>
                    <FinderSheetCloseContext.Provider value={close}>
                      <TooltipNavigation data={data} variant="sheet" />
                    </FinderSheetCloseContext.Provider>
                  </FinderSheetContext.Provider>
                  <Echo />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );
  beforeEach(() => close.mockClear());

  it('opens the chosen item and closes the sheet', async () => {
    await render();
    await act(async () => options()[2].click());
    expect(route()).toBe('/t/12?lang=de');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes the sheet on Enter as well', async () => {
    await render();
    await press('ArrowDown');
    await press('Enter');
    expect(route()).toBe('/t/11?lang=de');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('stays open when stepping with the sheet row', async () => {
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Next tooltip"]')!.click(),
    );
    expect(close).not.toHaveBeenCalled();
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

describe('global declarations in the finder', () => {
  const source = {
    ...data,
    bundle: {
      ...data.bundle,
      tooltips: {
        2: {
          hash: 2,
          text: { en: { text: 'var Alpha = 10\nvar Beta = 20', author: 'test', lastUpdated: 1 } },
          associated: [],
        },
        3: {
          hash: 3,
          text: { en: { text: 'title Heading (\nBody\n)', author: 'test', lastUpdated: 1 } },
          associated: [],
        },
      },
    },
  } as unknown as EditorData;
  it('selects bare names, exposes values on hover, and steps within an aggregate', async () => {
    await mount('/t/2?global=Alpha', source);
    expect(field().value).toBe('Alpha');
    await open();
    expect(options().map((option) => option.querySelector('[class*=name]')?.textContent)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(options()[1].title).toBe('20');
    await press('ArrowDown');
    await press('Enter');
    expect(route()).toBe('/t/2?global=Beta');
    expect(field().value).toBe('Beta');
    await press('ArrowUp');
    expect(route()).toBe('/t/2?global=Alpha');
  });
  it('updates hover values and newly added declarations from an aggregate draft', async () => {
    await mount('/t/2?global=Alpha', source);
    const base = source.bundle.tooltips[2];
    useDraftStore.setState({ hydrated: true });
    await act(async () =>
      useDraftStore
        .getState()
        .edit(base, 'en', 'var Alpha = changed\nvar Beta = 20\nvar Gamma = new', 'test'),
    );
    await paintGlobals();
    expect(field().value).toBe('Alpha');
    await open();
    await paintGlobals();
    expect(options()).toHaveLength(3);
    expect(options()[0].title).toBe('changed');
    await act(async () => useDraftStore.getState().discard(2));
    await paintGlobals();
    expect(options()).toHaveLength(2);
    expect(options()[0].title).toBe('10');
  });
  it('restores saved hover contents when a pre-existing value draft is discarded', async () => {
    const base = source.bundle.tooltips[2];
    useDraftStore.setState({ hydrated: true });
    useDraftStore.getState().edit(base, 'en', 'var Alpha = changed\nvar Beta = 20', 'test');
    await mount('/t/2?global=Alpha', source);
    await open();
    expect(options()[0].title).toBe('changed');
    await act(async () => useDraftStore.getState().discard(2));
    await paintGlobals();
    expect(options()[0].title).toBe('10');
  });
  it('opens the first declaration when switching global type', async () => {
    await mount('/t/10', source);
    const category = host.querySelector<HTMLSelectElement>('[aria-label="Category"]')!;
    await act(async () => {
      category.value = 'globals-titles';
      category.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(route()).toBe('/t/3?global=Heading');
    expect(field().value).toBe('Heading');
  });
});
