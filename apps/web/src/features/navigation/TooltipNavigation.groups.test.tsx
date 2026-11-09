// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { defaultDeviceSettings, useSettingsStore } from '../../stores/settings';
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
const weapon = (hash: number, name: string) => ({
  itemHash: hash,
  itemName: name,
  owners: [hash],
  ownerNames: { [hash]: name },
});
const data = {
  categories: [
    { id: 'weapon-trait-exotic', label: 'Exotic Weapon Perks', group: 'Weapons', order: 102 },
    { id: 'weapon-frame-exotic', label: 'Exotic Frames', group: 'Weapons', order: 122 },
    { id: 'weapon-catalyst-exotic', label: 'Exotic Catalysts', group: 'Weapons', order: 130 },
    { id: 'armor-mod-general', label: 'Armor Mods', group: 'Armor', order: 220 },
    { id: 'armor-mod-activity', label: 'Activity Mods', group: 'Armor', order: 240 },
  ],
  items: {
    100: item(100, 'Dead Frame', 'weapon-frame-exotic', weapon(1001, 'Dead Messenger')),
    101: item(101, 'The Fundamentals', 'weapon-trait-exotic', {
      itemHash: 1001,
      itemName: 'Dead Messenger',
      owners: [1001, 1002],
      ownerNames: { 1001: 'Dead Messenger', 1002: 'Hard Light' },
    }),
    102: item(102, 'Dead Catalyst', 'weapon-catalyst-exotic', weapon(1001, 'Dead Messenger')),
    103: item(103, 'Light Frame', 'weapon-frame-exotic', weapon(1002, 'Hard Light')),
    104: item(104, 'Worm Perk', 'weapon-trait-exotic', weapon(1003, 'Whisper of the Worm')),
    12: item(12, 'Ordinary Mod', 'armor-mod-general'),
    // Real manifest hashes: plug categories enhancements.raid_v520 and enhancements.season_maverick.
    518521232: item(518521232, 'Precise Oracle Disruptor', 'armor-mod-activity'),
    1560574695: item(1560574695, 'Nightmare Breaker', 'armor-mod-activity'),
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-09T00:00:00Z',
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

let host: HTMLDivElement;
let root: Root;
let back: () => void = () => undefined;
const originalDrafts = useDraftStore.getState();
const originalSettings = useSettingsStore.getState().device;

function Echo() {
  const location = useLocation();
  const navigate = useNavigate();
  back = () => navigate(-1);
  return <output data-route="">{`${location.pathname}${location.search}`}</output>;
}
async function mount(path: string, sheet = false) {
  await act(async () =>
    root.render(
      <MemoryRouter key={path} initialEntries={[path]}>
        <Routes>
          <Route
            path="/t/:hash"
            element={
              <>
                <div data-shell-overlay={sheet ? 'Find' : undefined}>
                  <FinderSheetContext.Provider value={sheet}>
                    <TooltipNavigation data={data} variant={sheet ? 'sheet' : 'bar'} />
                  </FinderSheetContext.Provider>
                </div>
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
const select = (label: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const route = () => host.querySelector('[data-route]')!.textContent;
const position = () => host.querySelector<HTMLElement>('span[role="status"]:not(.sr-only)')!;
const rows = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const rest = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
async function choose(target: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await rest();
}
async function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ...init });
  await act(async () => void window.dispatchEvent(event));
  await rest();
  return event;
}
async function press(key: string) {
  await act(
    async () =>
      void field().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      ),
  );
  await rest();
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const labels = (target: HTMLSelectElement) => [...target.options].map((option) => option.text);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDraftStore.setState({ drafts: {} });
  useSettingsStore.setState({ device: { ...defaultDeviceSettings } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDraftStore.setState(originalDrafts);
  useSettingsStore.setState({ device: originalSettings });
});

describe('Exotic Weapons dropdowns', () => {
  it('folds the four kinds into one category and lists weapons A–Z after "All exotic weapons", with no counts', async () => {
    await mount('/t/100');
    expect(labels(select('Category')!)).toEqual(['Exotic Weapons', 'Armor Mods', 'Activity Mods']);
    expect(labels(select('Weapon')!)).toEqual([
      'All exotic weapons',
      'Dead Messenger',
      'Hard Light',
      'Whisper of the Worm',
    ]);
    expect(select('Weapon')!.value).toBe('1001');
    expect(position().textContent).toBe('1 of 3');
  });

  it('derives the weapon from the route: the item, an explicit owner, or All', async () => {
    await mount('/t/103');
    expect(select('Weapon')!.value).toBe('1002');
    expect(position().textContent).toBe('1 of 2');
    await mount('/t/101?g=1002');
    expect(select('Weapon')!.value).toBe('1002');
    expect(position().textContent).toBe('2 of 2');
    await mount('/t/103?g=all');
    expect(select('Weapon')!.value).toBe('all');
    expect(position().textContent).toBe('4 of 6');
  });

  it('has no weapon or activity dropdown in a category without groups, and an Activity one for Activity Mods', async () => {
    await mount('/t/12');
    expect(select('Weapon')).toBeNull();
    expect(select('Activity')).toBeNull();
    await mount('/t/518521232');
    expect(select('Weapon')).toBeNull();
    expect(labels(select('Activity')!)).toEqual([
      'All activities',
      'Vault of Glass',
      'Nightmares (Shadowkeep)',
    ]);
    expect(select('Activity')!.value).toBe('enhancements.raid_v520');
  });

  it('opens the first entry of a new category in the All scope, and of a weapon in its own', async () => {
    await mount('/t/12');
    await choose(select('Category')!, 'exotic-weapons');
    expect(route()).toBe('/t/100?g=all');
    expect(select('Weapon')!.value).toBe('all');
    await choose(select('Weapon')!, '1002');
    expect(route()).toBe('/t/103');
    expect(select('Weapon')!.value).toBe('1002');
    await choose(select('Category')!, 'armor-mod-activity');
    expect(route()).toBe('/t/518521232?g=all');
  });

  it('keeps the item when "All" is chosen, and Back restores the scope', async () => {
    await mount('/t/101?g=1002');
    await choose(select('Weapon')!, 'all');
    expect(route()).toBe('/t/101?g=all:1002');
    expect(select('Weapon')!.value).toBe('all');
    expect(position().textContent).toBe('5 of 6');
    await act(async () => back());
    expect(route()).toBe('/t/101?g=1002');
    expect(select('Weapon')!.value).toBe('1002');
  });

  it('keeps the language when the scope changes', async () => {
    await mount('/t/100?lang=de');
    await choose(select('Weapon')!, 'all');
    expect(route()).toBe('/t/100?lang=de&g=all');
  });
});

describe('Exotic Weapons stepping', () => {
  it('Shift+wheel stops at the ends of the chosen weapon', async () => {
    await mount('/t/100');
    for (const expected of ['/t/101', '/t/102', '/t/102']) {
      const event = await wheel({ shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(route()).toBe(expected);
    }
    expect(position().textContent).toBe('3 of 3');
    await wheel({ shiftKey: true, deltaY: -100 });
    await wheel({ shiftKey: true, deltaY: -100 });
    await wheel({ shiftKey: true, deltaY: -100 });
    expect(route()).toBe('/t/100');
  });

  it('Shift+wheel in All crosses weapons in kind order', async () => {
    await mount('/t/102?g=all');
    await wheel({ shiftKey: true });
    expect(route()).toBe('/t/103?g=all');
    await wheel({ shiftKey: true });
    expect(route()).toBe('/t/101?g=all:1002');
    expect(position().textContent).toBe('5 of 6');
    expect(select('Weapon')!.value).toBe('all');
  });

  it('Alt+Shift+wheel moves one weapon and stops at the last', async () => {
    await mount('/t/101');
    await wheel({ shiftKey: true, altKey: true });
    expect(route()).toBe('/t/103');
    expect(select('Weapon')!.value).toBe('1002');
    await wheel({ shiftKey: true, altKey: true });
    expect(route()).toBe('/t/104');
    await wheel({ shiftKey: true, altKey: true });
    expect(route()).toBe('/t/104');
    await wheel({ shiftKey: true, altKey: true, deltaY: -100 });
    expect(route()).toBe('/t/103');
  });

  it('in All, Alt+Shift+wheel jumps to the next weapon inside the same list', async () => {
    await mount('/t/101?g=all');
    await wheel({ shiftKey: true, altKey: true });
    expect(route()).toBe('/t/103?g=all');
  });

  it('the device setting swaps the two gestures', async () => {
    useSettingsStore.setState({ device: { ...defaultDeviceSettings, finderWheel: 'groups' } });
    await mount('/t/100');
    await wheel({ shiftKey: true });
    expect(route()).toBe('/t/103');
    await wheel({ shiftKey: true, altKey: true });
    expect(route()).toBe('/t/101?g=1002');
    await wheel({ shiftKey: true, altKey: true, deltaY: -100 });
    expect(route()).toBe('/t/103');
  });

  it('either gesture steps entries in a category without groups', async () => {
    useSettingsStore.setState({ device: { ...defaultDeviceSettings, finderWheel: 'groups' } });
    await mount('/t/12');
    expect(select('Weapon')).toBeNull();
    await wheel({ shiftKey: true });
    expect(route()).toBe('/t/12');
  });

  it('PageDown and PageUp on the closed field step weapons; the arrows step entries', async () => {
    await mount('/t/100');
    await press('PageDown');
    expect(route()).toBe('/t/103');
    await press('PageDown');
    expect(route()).toBe('/t/104');
    await press('PageDown');
    expect(route()).toBe('/t/104');
    await press('PageUp');
    expect(route()).toBe('/t/103');
    await mount('/t/100?lang=de');
    await press('ArrowDown');
    expect(route()).toBe('/t/101?lang=de');
  });

  it('writes the group when a shared perk is reached under its second owner', async () => {
    await mount('/t/103');
    await wheel({ shiftKey: true });
    expect(route()).toBe('/t/101?g=1002');
    expect(position().textContent).toBe('2 of 2');
    expect(field().title).toBe('Shared perk — used on: Dead Messenger, Hard Light');
  });
});

describe('Exotic Weapons list', () => {
  it("lists a weapon's entries with kind and hash, and names the other owner of a shared perk", async () => {
    await mount('/t/101');
    await act(async () => field().click());
    expect(rows().map((row) => row.textContent)).toEqual([
      'Dead FrameFrame · 100',
      'The FundamentalsPerk · 101 · also Hard Light',
      'Dead CatalystCatalyst · 102',
    ]);
    expect(rows()[1].getAttribute('data-current')).toBe('true');
  });

  it('lists every weapon in All, leading with the weapon, and marks only the open listing as current', async () => {
    await mount('/t/101?g=1002');
    await act(async () => field().click());
    // The weapon is a column of its own (the alphabetical anchor); the entry follows with its kind.
    await choose(select('Weapon')!, 'all');
    await act(async () => field().click());
    expect(rows().map((row) => row.textContent)).toEqual([
      'Dead MessengerDead Frame · Frame · 100',
      'Dead MessengerThe Fundamentals · Perk · 101 · shared',
      'Dead MessengerDead Catalyst · Catalyst · 102',
      'Hard LightLight Frame · Frame · 103',
      'Hard LightThe Fundamentals · Perk · 101 · shared',
      'Whisper of the WormWorm Perk · Perk · 104',
    ]);
    expect(rows().map((row) => row.getAttribute('data-current'))).toEqual([
      null,
      null,
      null,
      null,
      'true',
      null,
    ]);
    expect(new Set(rows().map((row) => row.id)).size).toBe(6);
  });

  it('commits a row of the All list without leaving the All scope, and a shared row under its owner', async () => {
    await mount('/t/100?g=all');
    await act(async () => field().click());
    await act(async () => rows()[4].click());
    await rest();
    expect(route()).toBe('/t/101?g=all:1002');
    expect(position().textContent).toBe('5 of 6');
  });

  it('commits a row of a weapon without writing a scope the item implies', async () => {
    await mount('/t/100');
    await act(async () => field().click());
    await act(async () => rows()[2].click());
    await rest();
    expect(route()).toBe('/t/102');
  });

  it('widens a search from the weapon to all weapons, then to every category', async () => {
    await mount('/t/100');
    await act(async () => field().click());
    await type('light frame');
    const empty = () => host.querySelector('p')!;
    expect(rows()).toHaveLength(0);
    expect(empty().textContent).toContain('No tooltips match “light frame” in Dead Messenger.');
    const buttons = () =>
      [...empty().querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons()).toEqual(['Search all exotic weapons', 'Search all categories', 'Clear']);
    await act(async () => empty().querySelectorAll('button')[0].click());
    expect(rows().map((row) => row.textContent)).toEqual(['Hard LightLight Frame · Frame · 103']);
  });

  it('Enter on an empty list widens one level at a time, and Clear or Escape restore the scope', async () => {
    await mount('/t/100');
    await act(async () => field().click());
    await type('light frame');
    expect(rows()).toHaveLength(0);
    await press('Enter');
    expect(rows().map((row) => row.textContent)).toEqual(['Hard LightLight Frame · Frame · 103']);
    await type('zzz');
    expect(rows()).toHaveLength(0);
    await press('Enter');
    expect(host.querySelector('p')!.textContent).toContain('No tooltips match “zzz”.');
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Clear')!
        .click(),
    );
    // Cleared: back to the open item's own weapon.
    expect(rows().map((row) => row.textContent)).toEqual([
      'Dead FrameFrame · 100',
      'The FundamentalsPerk · 101 · also Hard Light',
      'Dead CatalystCatalyst · 102',
    ]);
    await press('Escape');
    expect(rows()).toHaveLength(0);
    expect(route()).toBe('/t/100');
    expect(select('Weapon')!.value).toBe('1001');
  });

  it('keeps one row per listing while typing, so a hash listed twice never leaves a stale copy', async () => {
    await mount('/t/101?g=all:1002');
    await act(async () => field().click());
    for (const text of ['f', 'fu', 'fun', 'fund', 'fundamentals']) await type(text);
    expect(rows().map((row) => row.textContent)).toEqual([
      'Dead MessengerThe Fundamentals · Perk · 101 · shared',
      'Hard LightThe Fundamentals · Perk · 101 · shared',
    ]);
    expect(new Set(rows().map((row) => row.id)).size).toBe(2);
    expect(rows().filter((row) => row.hasAttribute('data-current'))).toHaveLength(1);
    await type('light');
    expect(rows().length).toBeGreaterThan(0);
    expect(new Set(rows().map((row) => row.id)).size).toBe(rows().length);
  });

  it('shows the position as "n in Exotic Weapons" when the open item is outside the category list', async () => {
    await mount('/t/999');
    expect(position().textContent).toMatch(/^\d+ in /);
  });
});

describe('phone sheet', () => {
  it('adds a Weapon row with Previous and Next weapon buttons that step weapons', async () => {
    await mount('/t/100', true);
    const previous = host.querySelector<HTMLButtonElement>('[aria-label="Previous weapon"]')!;
    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next weapon"]')!;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    await act(async () => next.click());
    await rest();
    expect(route()).toBe('/t/103');
    expect(select('Weapon')!.value).toBe('1002');
    expect(position().textContent).toBe('1 of 2');
  });

  it('has no weapon row in a category without groups', async () => {
    await mount('/t/12', true);
    expect(host.querySelector('[aria-label="Previous weapon"]')).toBeNull();
    expect(host.querySelector('[aria-label="Previous tooltip"]')).not.toBeNull();
  });
});
