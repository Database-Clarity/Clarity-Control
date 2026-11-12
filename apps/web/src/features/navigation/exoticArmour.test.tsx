// @vitest-environment jsdom
import { act } from 'react';
import { picker } from './finderPicker.testUtils';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipPreview } from '../preview/TooltipPreview';
import { editorName, exoticPiece, listName, navigationGroups, sharesAllOwners } from './catalog';
import { presentCategories } from '../../services/categoryLabels';
import { TooltipNavigation } from './TooltipNavigation';
import { exoticArmourRowIcon } from './groupIcons';
import armourIcons from './exotic-armor-icons.json';

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
    { id: 'armor-trait-exotic', label: 'Exotic Armor', group: 'Armor', order: 10 },
    { id: 'weapon-perk', label: 'Weapon Parts', group: 'Weapons', order: 20 },
  ],
  items: {
    101: perk(101, 'Chaotic Exchanger', {
      icon: '/common/destiny2_content/icons/perk-101.png',
      itemHash: 1906093346,
      itemName: 'Contraverse Hold',
      owners: [1906093346, 3261527845],
      ownerNames: { 1906093346: 'Contraverse Hold', 3261527845: 'Contraverse Hold' },
    }),
    // Owner-less in the data: only itemHash/itemName name the piece.
    102: perk(102, 'Praxic Lift', { itemHash: 77, itemName: 'Praxic Vestment' }),
    103: perk(103, 'Sect of Force', {
      icon: '/common/destiny2_content/icons/perk-103.png',
      itemHash: 796577360,
      itemName: 'Aeon Safe',
      ...aeonOwners,
    }),
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
    expect(section.label).toBe('Exotic Armor');
    expect(section.items.map((entry) => [entry.hash, entry.name, entry.perkName])).toEqual([
      [103, 'Aeon Safe/Soul/Swift · Sect of Force', 'Sect of Force'],
      [4, 'Aeon Safe/Soul/Swift · Sect of Insight', 'Sect of Insight'],
      [101, 'Contraverse Hold', 'Chaotic Exchanger'],
      [5, 'Orphan Perk', undefined],
      [102, 'Praxic Vestment', 'Praxic Lift'],
    ]);
  });

  it('leaves other categories and the item data itself unchanged', () => {
    expect(data.items[101].name).toBe('Chaotic Exchanger');
    const weapons = navigationGroups(data, '')
      .flatMap((group) => group.sections)
      .find((section) => section.id === 'weapon-perk')!;
    expect(weapons.label).toBe('Weapon Parts');
    expect(weapons.items.map((entry) => entry.name)).toEqual(['Outlaw']);
    expect(listName(data.items[20], data)).toBe('Outlaw');
    expect(listName(data.items[101], data)).toBe('Contraverse Hold');
  });

  it('finds a piece by its own name, by any of a set, and by its perk name', () => {
    for (const query of ['contraverse', 'CONTRAVERSE hold', 'chaotic', 'exchanger']) {
      expect(exotic(data, query)!.items.map((entry) => entry.hash)).toEqual([101]);
    }
    expect(exotic(data, 'praxic vest')!.items.map((entry) => entry.hash)).toEqual([102]);
    expect(exotic(data, 'lift')!.items.map((entry) => entry.hash)).toEqual([102]);
    expect(exotic(data, 'aeon soul')!.items.map((entry) => entry.hash)).toEqual([103, 4]);
    expect(exotic(data, 'sect of insight')!.items.map((entry) => entry.hash)).toEqual([4]);
    expect(exotic(data, 'nothing here')).toBeUndefined();
  });
});

describe('exotic armour row icons', () => {
  const contraverse = `${armourIcons.source.prefix}${(armourIcons.icons as Record<string, string>)['1906093346']}`;
  it('shows the piece icon for one piece, the perk icon for several or none', () => {
    expect(contraverse).toMatch(/^\/common\/destiny2_content\/icons\/\w+\.jpg$/);
    expect(exoticArmourRowIcon(data.items[101])).toBe(contraverse);
    expect(exoticArmourRowIcon(data.items[103])).toBe(
      '/common/destiny2_content/icons/perk-103.png',
    );
    // Owner-less in the data (itemHash only): the perk keeps its own icon.
    expect(exoticArmourRowIcon(data.items[102])).toBe('');
    expect(
      exoticArmourRowIcon(perk(7, 'Lone', { icon: '/p.png', itemHash: 1906093346 }) as never),
    ).toBe('/p.png');
    // Other categories keep the row's own icon.
    expect(exoticArmourRowIcon(data.items[20])).toBeUndefined();
  });

  it('leaves the box empty for a piece missing from the icon file, never another icon', () => {
    const missing = perk(8, 'Unknown Perk', {
      icon: '/common/destiny2_content/icons/perk-8.png',
      owners: [11, 12],
      ownerNames: { 11: 'Unlisted Piece', 12: 'Unlisted Piece' },
    });
    expect(exoticArmourRowIcon(missing as never)).toBe('');
  });
});

describe('exotic class items', () => {
  // Generator shape (v2 f9a3a36): every class item perk is on all three class items.
  const spirit = {
    ...perk(30, 'Spirit of the Swarm', {
      icon: '/common/destiny2_content/icons/spirit-30.png',
      owners: [266021826, 2273643087, 2809120022],
      ownerNames: { 266021826: 'Stoicism', 2273643087: 'Solipsism', 2809120022: 'Relativism' },
    }),
    categoryId: 'armor-trait-exotic-class-item',
  };
  const withClassItems = {
    ...data,
    categories: presentCategories([
      ...data.categories,
      {
        id: 'armor-trait-exotic-class-item',
        label: 'Exotic Class Item Perks',
        group: 'Armor',
        order: 11,
      },
    ]),
    items: { ...data.items, 30: spirit },
  } as unknown as EditorData;
  const sections = () => navigationGroups(withClassItems, '').flatMap((group) => group.sections);

  it('lists every class item perk in its own category, after Exotic Armor', () => {
    const ids = sections().map((section) => section.id);
    expect(ids.indexOf('armor-trait-exotic-class-item')).toBe(
      ids.indexOf('armor-trait-exotic') + 1,
    );
    const section = sections().find((entry) => entry.id === 'armor-trait-exotic-class-item')!;
    expect(section.label).toBe('Exotic Class Items');
    expect(section.grouping).toBeUndefined();
    expect(section.items.map((entry) => [entry.hash, entry.name])).toEqual([
      [30, 'Spirit of the Swarm'],
    ]);
    expect(
      sections()
        .find((entry) => entry.id === 'armor-trait-exotic')!
        .items.some((entry) => entry.hash === 30),
    ).toBe(false);
  });

  it('drops the per-row shared mark only where every entry has the same owners', () => {
    const other = { ...spirit, hash: 31, name: 'Spirit of the Star-Eater' };
    expect(sharesAllOwners([spirit, other] as never)).toBe(true);
    expect(sharesAllOwners([spirit, { ...other, owners: [266021826, 2273643087] }] as never)).toBe(
      false,
    );
    expect(sharesAllOwners([spirit] as never)).toBe(false);
    expect(sharesAllOwners([data.items[101], data.items[102]])).toBe(false);
  });

  it('keeps the perk name and the perk icon', () => {
    expect(editorName(spirit as never)).toBe('Spirit of the Swarm');
    expect(exoticArmourRowIcon(spirit as never)).toBeUndefined();
  });
});

describe('exotic armour in the editor headings', () => {
  it('names the open item "Piece · Perk", and leaves every other item alone', () => {
    expect(editorName(data.items[101])).toBe('Contraverse Hold · Chaotic Exchanger');
    expect(editorName(data.items[102])).toBe('Praxic Vestment · Praxic Lift');
    expect(editorName(data.items[103])).toBe('Aeon Safe/Soul/Swift · Sect of Force');
    expect(editorName(data.items[5])).toBe('Orphan Perk');
    expect(editorName(data.items[20])).toBe('Outlaw');
    expect(exoticPiece(data.items[20])).toBeUndefined();
    expect(data.items[101].name).toBe('Chaotic Exchanger');
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
    await mount('/t/101');
    expect(field().value).toBe('Contraverse Hold');
    expect(picker(host, 'Category')!.title).toBe('Exotic Armor');
    await act(async () => root.render(null));
    await mount('/t/4');
    expect(field().value).toBe('Aeon Safe/Soul/Swift · Sect of Insight');
  });

  it('shows the piece icon on a one-piece row and the perk icon on an Aeon row', async () => {
    await mount('/t/101');
    await act(async () => field().click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const icon = (text: string) =>
      options()
        .find((option) => option.textContent?.includes(text))!
        .querySelector('img')
        ?.getAttribute('src');
    expect(icon('Contraverse Hold')).toBe(
      `https://www.bungie.net${armourIcons.source.prefix}${(armourIcons.icons as Record<string, string>)['1906093346']}`,
    );
    expect(icon('Sect of Force')).toBe(
      'https://www.bungie.net/common/destiny2_content/icons/perk-103.png',
    );
  });

  it('shows the perk beside the hash, and a search by perk selects the piece row', async () => {
    await mount('/t/101');
    await act(async () => field().click());
    const row = options().find((option) => option.textContent?.includes('Contraverse Hold'))!;
    expect(row.querySelector('small')!.textContent).toBe('Chaotic Exchanger · 101');
    // A set's rows name the pieces once and keep each perk on the right; the slash list is the
    // shared mark, so the small text does not repeat it.
    const aeon = options().filter((option) => option.textContent?.startsWith('Aeon'));
    expect(aeon.map((option) => option.querySelector('[class*=name]')!.textContent)).toEqual([
      'Aeon Safe/Soul/Swift',
      'Aeon Safe/Soul/Swift',
    ]);
    expect(aeon.map((option) => option.querySelector('small')!.textContent)).toEqual([
      'Sect of Force · 103',
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
    expect(options().map((option) => option.querySelector('[class*=name]')!.textContent)).toEqual([
      'Praxic Vestment',
    ]);
    await act(async () =>
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(host.querySelector('[data-route]')!.textContent).toBe('/t/102');
  });
});
