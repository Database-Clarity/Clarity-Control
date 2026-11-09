// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipPreview } from '../preview/TooltipPreview';
import { editorName, exoticPiece, listName, navigationGroups } from './catalog';
import { TooltipNavigation } from './TooltipNavigation';

// Shapes follow the generator's items.json: the perk carries its owning pieces, not the pieces.
const perk = (hash: number, name: string, extra = {}) => ({
  hash,
  name,
  icon: '',
  categoryId: 'armor-trait-exotic',
  inGameDescription: '',
  ...extra,
});
const aeonOwners = {
  owners: [796577360, 859709617, 1654461647, 2615220262],
  ownerNames: {
    796577360: 'Aeon Safe',
    859709617: 'Aeon Soul',
    1654461647: 'Aeon Safe',
    2615220262: 'Aeon Swift',
  },
};
const data = {
  categories: [
    { id: 'armor-trait-exotic', label: 'Exotic Armor Perks', group: 'Armor', order: 10 },
    { id: 'weapon-perk', label: 'Weapon Parts', group: 'Weapons', order: 20 },
  ],
  items: {
    1: perk(1, 'Chaotic Exchanger', {
      itemHash: 1906093346,
      itemName: 'Contraverse Hold',
      owners: [1906093346, 3261527845],
      ownerNames: { 1906093346: 'Contraverse Hold', 3261527845: 'Contraverse Hold' },
    }),
    // Owner-less in the data: only itemHash/itemName name the piece.
    2: perk(2, 'Praxic Lift', { itemHash: 77, itemName: 'Praxic Vestment' }),
    3: perk(3, 'Sect of Force', { itemHash: 796577360, itemName: 'Aeon Safe', ...aeonOwners }),
    4: perk(4, 'Sect of Insight', { itemHash: 796577360, itemName: 'Aeon Safe', ...aeonOwners }),
    // Not a piece-linked perk: stays as it is.
    5: perk(5, 'Orphan Perk'),
    20: { ...perk(20, 'Outlaw'), categoryId: 'weapon-perk' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-03T00:00:00Z',
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

const exotic = (source = data, query = '') =>
  navigationGroups(source, query)
    .flatMap((group) => group.sections)
    .find((section) => section.id === 'armor-trait-exotic');

describe('exotic armour in the list', () => {
  it('lists the armour piece, labelled as exotic armour, and opens the same perk hash', () => {
    const section = exotic()!;
    expect(section.label).toBe('Exotic Armor Perks');
    expect(section.items.map((entry) => [entry.hash, entry.name, entry.perkName])).toEqual([
      [3, 'Aeon Safe/Soul/Swift · Sect of Force', 'Sect of Force'],
      [4, 'Aeon Safe/Soul/Swift · Sect of Insight', 'Sect of Insight'],
      [1, 'Contraverse Hold', 'Chaotic Exchanger'],
      [5, 'Orphan Perk', undefined],
      [2, 'Praxic Vestment', 'Praxic Lift'],
    ]);
  });

  it('leaves other categories and the item data itself unchanged', () => {
    expect(data.items[1].name).toBe('Chaotic Exchanger');
    const weapons = navigationGroups(data, '')
      .flatMap((group) => group.sections)
      .find((section) => section.id === 'weapon-perk')!;
    expect(weapons.label).toBe('Weapon Parts');
    expect(weapons.items.map((entry) => entry.name)).toEqual(['Outlaw']);
    expect(listName(data.items[20], data)).toBe('Outlaw');
    expect(listName(data.items[1], data)).toBe('Contraverse Hold');
  });

  it('finds a piece by its own name, by any of a set, and by its perk name', () => {
    for (const query of ['contraverse', 'CONTRAVERSE hold', 'chaotic', 'exchanger']) {
      expect(exotic(data, query)!.items.map((entry) => entry.hash)).toEqual([1]);
    }
    expect(exotic(data, 'praxic vest')!.items.map((entry) => entry.hash)).toEqual([2]);
    expect(exotic(data, 'lift')!.items.map((entry) => entry.hash)).toEqual([2]);
    expect(exotic(data, 'aeon soul')!.items.map((entry) => entry.hash)).toEqual([3, 4]);
    expect(exotic(data, 'sect of insight')!.items.map((entry) => entry.hash)).toEqual([4]);
    expect(exotic(data, 'nothing here')).toBeUndefined();
  });
});

describe('exotic armour in the editor headings', () => {
  it('names the open item "Piece · Perk", and leaves every other item alone', () => {
    expect(editorName(data.items[1])).toBe('Contraverse Hold · Chaotic Exchanger');
    expect(editorName(data.items[2])).toBe('Praxic Vestment · Praxic Lift');
    expect(editorName(data.items[3])).toBe('Aeon Safe/Soul/Swift · Sect of Force');
    expect(editorName(data.items[5])).toBe('Orphan Perk');
    expect(editorName(data.items[20])).toBe('Outlaw');
    expect(exoticPiece(data.items[20])).toBeUndefined();
    expect(data.items[1].name).toBe('Chaotic Exchanger');
  });

  it('does not repeat a piece whose perk is named after it', () => {
    const striders = perk(6, 'Blastwave Striders', {
      itemHash: 1188437342,
      itemName: 'Blastwave Striders',
      owners: [1188437342],
      ownerNames: { 1188437342: 'Blastwave Striders' },
    }) as unknown as EditorData['items'][number];
    expect(exoticPiece(striders)).toBeUndefined();
    expect(editorName(striders)).toBe('Blastwave Striders');
  });

  it('shows the piece above the perk in the preview header, only when there is one', () => {
    const markup = (piece?: string) =>
      renderToStaticMarkup(
        <TooltipPreview
          text=""
          lang="en"
          name="Chaotic Exchanger"
          piece={piece}
          globals={{ variables: '', titles: '' }}
        />,
      );
    expect(markup('Contraverse Hold')).toMatch(
      /Contraverse Hold<\/div><div[^>]*>Chaotic Exchanger/,
    );
    expect(markup()).not.toContain('Contraverse');
  });
});

describe('exotic armour in the finder', () => {
  let host: HTMLDivElement;
  let root: Root;
  function Echo() {
    const location = useLocation();
    return <output data-route="">{location.pathname}</output>;
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const mount = (path: string) =>
    act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/t/:hash"
              element={
                <>
                  <TooltipNavigation data={data} />
                  <Echo />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );
  const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

  it('deep links to a perk hash still open it, shown under its piece name', async () => {
    await mount('/t/1');
    expect(field().value).toBe('Contraverse Hold');
    expect(host.querySelector<HTMLSelectElement>('select')!.selectedOptions[0].textContent).toBe(
      'Exotic Armor Perks',
    );
    await act(async () => root.render(null));
    await mount('/t/4');
    expect(field().value).toBe('Aeon Safe/Soul/Swift · Sect of Insight');
  });

  it('shows the perk beside the hash, and a search by perk selects the piece row', async () => {
    await mount('/t/1');
    await act(async () => field().click());
    const row = options().find((option) => option.textContent?.includes('Contraverse Hold'))!;
    expect(row.querySelector('small')!.textContent).toBe('Chaotic Exchanger · 1');
    // A set's rows name the pieces once and keep each perk on the right; the slash list is the
    // shared mark, so the small text does not repeat it.
    const aeon = options().filter((option) => option.textContent?.startsWith('Aeon'));
    expect(aeon.map((option) => option.querySelector('span:nth-child(2)')!.textContent)).toEqual([
      'Aeon Safe/Soul/Swift',
      'Aeon Safe/Soul/Swift',
    ]);
    expect(aeon.map((option) => option.querySelector('small')!.textContent)).toEqual([
      'Sect of Force · 3',
      'Sect of Insight · 4',
    ]);
    expect(aeon[0].title).toMatch(/^Shared perk — used on: Aeon Safe, Aeon Soul, Aeon Swift/);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        field(),
        'praxic lift',
      );
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      options().map((option) => option.querySelector('span:nth-child(2)')!.textContent),
    ).toEqual(['Praxic Vestment']);
    await act(async () =>
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(host.querySelector('[data-route]')!.textContent).toBe('/t/2');
  });
});
