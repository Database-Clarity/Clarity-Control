// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSandboxPerkText, resetSandboxPerkText } from '../manifest/manifestText';
import { GroupedPerks } from './GroupedPerks';
import type { EditorData } from '../../stores/data';
import { useDataStore } from '../../stores/data';
import { groupedPerks, type GroupedPerk } from './grouping';

// The store's request is one per session; every case uses the same table.
vi.mock('../../services/generator', async (original) => ({
  ...(await original<typeof import('../../services/generator')>()),
  loadSandboxConflicts: vi.fn(async () => ({ 600: [60, 61] })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  resetSandboxPerkText();
  useDataStore.setState({ data: null });
});

const perk = (hash: number, name: string): GroupedPerk => ({
  hash,
  name,
  enhanced: false,
  reason: name ? 'canonical' : 'sandbox',
});

describe('GroupedPerks', () => {
  it('names sandbox perks from the bundled sandbox perk text', () => {
    resetSandboxPerkText({
      411682304: ['Collective Pugilism', 'Improved melee energy generation.'],
      5: ['', 'A stat line.'],
    });
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root!.render(
        <GroupedPerks
          perks={[
            perk(1888882410, 'Collective Pugilism'),
            perk(411682304, ''),
            perk(5, ''),
            perk(7, ''),
            { ...perk(8, ''), reason: 'alias' },
          ]}
        />,
      ),
    );
    const name = (hash: number) =>
      host.querySelector(`[data-grouped="${hash}"] [data-name]`)?.textContent;
    expect(name(1888882410)).toBe('Collective Pugilism');
    expect(name(411682304)).toBe('Collective Pugilism');
    expect(name(5)).toBe('Unnamed perk effect');
    // A blank definition is still a perk effect.
    expect(name(7)).toBe('Unnamed perk effect');
    expect(name(8)).toBe('Not in the game data');
  });

  it('does not call a sandbox perk unnamed when its text failed to load', async () => {
    await loadSandboxPerkText(() => Promise.reject(new Error('offline')));
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root!.render(
        <GroupedPerks perks={[perk(1888882410, 'Collective Pugilism'), perk(411682304, '')]} />,
      ),
    );
    const name = (hash: number) =>
      host.querySelector(`[data-grouped="${hash}"] [data-name]`)?.textContent;
    expect(name(1888882410)).toBe('Collective Pugilism');
    expect(name(411682304)).toBe('Name unavailable');
  });

  it.each([
    ['in the data', true],
    ['loaded separately', false],
  ])('links an unattached perk effect to its Sandbox perks row (table %s)', async (_, inData) => {
    resetSandboxPerkText({ 600: ['Cooling Baubles', ''] });
    const item = (hash: number, categoryId: string, extra = {}) => ({
      hash,
      name: 'Cooling Baubles',
      icon: '',
      categoryId,
      inGameDescription: '',
      sandboxPerkHashes: [600],
      ...extra,
    });
    const table = { 600: [60, 61] };
    const data = {
      categories: [
        { id: 'weapon-trait', label: 'T', group: 'W', order: 1, legacyType: 'Weapon Trait' },
        {
          id: 'weapon-trait-enhanced',
          label: 'E',
          group: 'W',
          order: 2,
          legacyType: 'Weapon Trait Enhanced',
        },
      ],
      items: {
        60: item(60, 'weapon-trait'),
        61: item(61, 'weapon-trait-enhanced', { baseHash: 60 }),
        62: item(62, 'weapon-trait', { sandboxPerkHashes: [620] }),
      },
      aliases: { 62: { to: 60, kind: 'name' }, 620: { to: 62, kind: 'sandbox' } },
      ...(inData ? { sandboxConflicts: table } : {}),
      bundle: { tooltips: {}, permissions: { users: {} }, pushed: {} },
    } as unknown as EditorData;
    useDataStore.setState({ data });
    const host = document.createElement('div');
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MemoryRouter>
          <GroupedPerks perks={groupedPerks(60, data)} />
        </MemoryRouter>,
      ),
    );
    expect([...host.querySelectorAll('h3')].map((title) => title.textContent?.trim())).toEqual([
      'Base',
      'Enhanced',
    ]);
    const missing = host.querySelectorAll('[data-grouped="600"][data-unattached]');
    expect(missing).toHaveLength(2);
    for (const row of missing) {
      expect(row.textContent).toContain('Not attached: used by base and enhanced');
      expect(row.querySelector('a')?.getAttribute('href')).toBe('/sandbox-perks?perk=600');
      expect(row.querySelector('button')).toBeNull();
    }
    expect(host.textContent).toContain(
      '4 share this text: 3 items, 1 perk effect. 1 more perk effect is not attached.',
    );
    expect(host.textContent).not.toMatch(/canonical|alias|pointer|\bvia\b|sandbox|manifest/i);
  });
});
