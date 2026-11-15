// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { weaponOwnerLabel, weaponOwners } from './weaponOwners';
import type { Item } from '../../services/generator';
import { useDataStore, type EditorData } from '../../stores/data';
import { LivePreviewIdentity } from './LivePreviewIdentity';
import { TooltipPreview } from './TooltipPreview';
import { publishSteppingTarget, settleStepping } from '../navigation/steppingActivity';
import { resetNamesForTests, useNamesStore } from '../terms/names';

const shared: Item = {
  hash: 2620589274,
  name: 'The Fundamentals',
  icon: '/common/perk.png',
  categoryId: 'weapon-trait-exotic',
  inGameDescription: '',
  owners: [46125926, 2812324401, 4124984448],
  ownerNames: {
    46125926: 'Dead Messenger',
    2812324401: 'Dead Messenger',
    4124984448: 'Hard Light',
  },
};
const single: Item = {
  ...shared,
  hash: 20,
  name: 'Single',
  owners: undefined,
  itemHash: 4124984448,
  itemName: 'Hard Light',
};
const ownerless: Item = {
  ...shared,
  hash: 21,
  name: 'Ownerless',
  owners: [],
  itemName: 'Unowned name',
};
const original = useDataStore.getState();
afterEach(() => {
  useDataStore.setState(original);
  settleStepping();
  resetNamesForTests();
});

it('uses generator hashes, deduplicates weapon definitions, and keeps missing icons empty', () => {
  const owners = weaponOwners(shared)!;
  expect(owners.map((owner) => owner.name)).toEqual(['Dead Messenger', 'Hard Light']);
  expect(owners.every((owner) => owner.icon.startsWith('/common/'))).toBe(true);
  expect(weaponOwnerLabel(owners)).toBe('Shared perk · Dead Messenger, Hard Light');
  for (const categoryId of [
    'weapon-frame-exotic',
    'weapon-trait-exotic',
    'weapon-catalyst-exotic',
    'weapon-perk-exotic',
  ]) {
    expect(weaponOwners({ ...single, categoryId })?.map((owner) => owner.name)).toEqual([
      'Hard Light',
    ]);
  }
  expect(weaponOwners(ownerless)).toEqual([]);
  expect(weaponOwners({ ...single, categoryId: 'weapon-perk' })).toBeUndefined();
  expect(weaponOwners({ ...single, ownerNames: {}, itemHash: 7, itemName: 'Hard Light' })).toEqual([
    { hash: 7, name: 'Hard Light', icon: '' },
  ]);
});

it('keeps the perk icon and switches owner identity immediately during deferred stepping', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  useDataStore.setState({
    data: {
      items: { [shared.hash]: shared, 20: single, 21: ownerless },
      aliases: {},
      categories: [],
      bundle: { tooltips: {} },
    } as unknown as EditorData,
  });
  const render = (lang: 'en' | 'de') =>
    root.render(
      <LivePreviewIdentity.Provider
        value={{ hash: shared.hash, name: shared.name, icon: shared.icon }}
      >
        <TooltipPreview
          name="Old body"
          text="Deferred body"
          lang={lang}
          globals={{ variables: '', titles: '' }}
          fill
        />
      </LivePreviewIdentity.Provider>,
    );
  try {
    await act(async () => render('en'));
    const header = () => host.querySelector('header')!;
    expect(header().textContent).toContain('Shared perk · Dead Messenger, Hard Light');
    expect(header().querySelectorAll('img')).toHaveLength(3);
    expect(header().querySelector('img')?.src).toBe('https://www.bungie.net/common/perk.png');
    act(() => publishSteppingTarget('/t/20', () => {}));
    expect(header().textContent).toContain('Hard Light');
    expect(header().textContent).not.toContain('Shared perk');
    expect(header().querySelectorAll('img')).toHaveLength(2);
    act(() => publishSteppingTarget('/t/21', () => {}));
    expect(header().textContent).not.toContain('Hard Light');
    expect(header().textContent).not.toContain('Unowned name');
    expect(header().querySelectorAll('img')).toHaveLength(1);
    expect(host.textContent).toContain('Deferred body');
    act(settleStepping);
    await act(async () => render('de'));
    act(() =>
      useNamesStore.setState({
        byLang: {
          de: {
            status: 'ready',
            file: {
              v: 1,
              lang: 'de',
              manifestVersion: 'fixture',
              names: {},
              itemNames: { 46125926: 'Toter Bote', 4124984448: 'Hartes Licht' },
              setNames: {},
            },
          },
        },
      }),
    );
    expect(header().textContent).toContain('Shared perk · Toter Bote, Hartes Licht');
    expect(header().querySelector('button')?.hasAttribute('title')).toBe(false);
    act(() => header().querySelector<HTMLButtonElement>('button')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Shared perk · Dead Messenger, Hard Light',
    );
  } finally {
    await act(async () => root.unmount());
  }
});
