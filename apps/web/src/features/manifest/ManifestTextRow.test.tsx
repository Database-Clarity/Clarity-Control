// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore, type EditorData } from '../../stores/data';
import type { Item } from '../../services/generatorSchema';
import { ManifestTextRow } from './ManifestTextRow';
import {
  loadSandboxPerkText,
  manifestSummary,
  manifestText,
  resetSandboxPerkText,
  type SandboxPerkText,
} from './manifestText';

const item = (hash: number, more: Partial<Item>): Item => ({
  hash,
  name: `Item ${hash}`,
  icon: '',
  categoryId: 'weapon-trait',
  inGameDescription: '',
  ...more,
});
const perks: SandboxPerkText = {
  11: ['Kinetic Siphon', 'Rapid Kinetic weapon final blows create an Orb of Power.'],
  12: ['Shieldcrush', 'While you have an overshield, your melee recharges faster.'],
  13: ['', 'Hidden stat line.'],
  14: ['-10 Grenade ▼', '-10 Grenade ▼'],
};
const items = {
  1: item(1, { name: 'Rampage', inGameDescription: 'Kills grant increased damage.\nStacks 3x.' }),
  2: item(2, { name: 'Kinetic Siphon', categoryId: 'armor-mod-general', sandboxPerkHashes: [11] }),
  3: item(3, {
    name: 'Shieldcrush',
    categoryId: 'armor-mod-seasonal',
    sandboxPerkHashes: [11, 12, 12, 13, 99],
  }),
  4: item(4, { name: 'Bare', categoryId: 'verbs' }),
  5: item(5, { name: 'Empty perk', sandboxPerkHashes: [99] }),
  // An exotic weapon is several entries; each carries its own part's description.
  6: item(6, {
    name: 'The Right Choice',
    categoryId: 'weapon-frame-exotic',
    itemName: 'Sweet Business',
    inGameDescription: 'Every seventh bullet from this weapon ricochets to nearby targets.',
    sandboxPerkHashes: [11],
  }),
  7: item(7, {
    name: 'Business Time',
    categoryId: 'weapon-trait-exotic',
    itemName: 'Sweet Business',
    inGameDescription: 'Holding down the trigger boosts rate of fire and range.',
  }),
};

describe('manifestText', () => {
  it('prefers the entry’s own description, even when it has sandbox perks', () => {
    expect(manifestText(items[1], perks)).toEqual({
      kind: 'own',
      description: 'Kills grant increased damage.\nStacks 3x.',
    });
    expect(manifestText(items[6], undefined).kind).toBe('own');
    expect(manifestSummary(manifestText(items[1], perks))).toBe(
      'Kills grant increased damage. Stacks 3x.',
    );
  });
  it('falls back to the sandbox perk, with its name and hash', () => {
    expect(manifestText(items[2], perks)).toEqual({
      kind: 'sandbox',
      perks: [{ hash: 11, name: 'Kinetic Siphon', description: perks[11][1] }],
    });
  });
  it('lists several perks once each, in order, and skips the ones without text', () => {
    const text = manifestText(items[3], perks);
    expect(text.kind === 'sandbox' && text.perks.map((perk) => perk.hash)).toEqual([11, 12, 13]);
  });
  it('waits for the perk text only when the fallback is needed', () => {
    expect(manifestText(items[2], undefined)).toEqual({ kind: 'loading' });
    expect(manifestText(items[4], undefined)).toEqual({ kind: 'none', perkHashes: [] });
  });
  it('reports no description at all', () => {
    expect(manifestText(items[5], perks)).toEqual({ kind: 'none', perkHashes: [99] });
    expect(manifestText(undefined, perks)).toEqual({ kind: 'none', perkHashes: [] });
    expect(manifestSummary(manifestText(items[5], perks))).toBe('No manifest description');
  });
  it('gives each exotic weapon entry its own part, not the whole weapon', () => {
    expect(manifestText(items[6], perks)).toMatchObject({
      description: 'Every seventh bullet from this weapon ricochets to nearby targets.',
    });
    expect(manifestText(items[7], perks)).toMatchObject({
      description: 'Holding down the trigger boosts rate of fire and range.',
    });
  });
});

describe('sandbox perk text asset', () => {
  it('gives every bundled perk a name or a non-empty description', async () => {
    const asset = (await import('./sandbox-perks.json')).default as unknown as {
      perks: SandboxPerkText;
    };
    const entries = Object.values(asset.perks);
    expect(entries.length).toBeGreaterThan(1000);
    expect(entries.every(([name, text]) => name.trim() !== '' || text.trim() !== '')).toBe(true);
  });
  it('skips a perk listed only for its name', () => {
    const named: SandboxPerkText = { ...perks, 15: ['Name only', ''] };
    expect(manifestText(item(9, { sandboxPerkHashes: [15] }), named)).toEqual({
      kind: 'none',
      perkHashes: [15],
    });
  });
  it('includes the fallback for Electrified Conductor from the current generator', async () => {
    const asset = (await import('./sandbox-perks.json')).default as unknown as {
      perks: SandboxPerkText;
    };
    const text = manifestText(item(1886465, { sandboxPerkHashes: [3341240528] }), asset.perks);
    expect(text.kind).toBe('sandbox');
  });
});

describe('ManifestTextRow', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, value: string) => void kept.set(name, value),
    });
    resetSandboxPerkText(perks);
    useDataStore.setState({
      data: {
        categories: [],
        items,
        aliases: {},
        bundle: { tooltips: {} },
      } as unknown as EditorData,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSandboxPerkText();
    useDataStore.setState({ data: null });
    vi.unstubAllGlobals();
  });
  const show = (hash: number) => act(async () => root.render(<ManifestTextRow hash={hash} />));

  it('is open by default with the name, hash, and description, and follows the entry', async () => {
    await show(1);
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    const label = () => host.querySelector('section')?.getAttribute('aria-label');
    expect(label()).toBe('Manifest text for Rampage, 1');
    expect(host.textContent).toContain('Kills grant increased damage.');
    await show(7);
    expect(label()).toBe('Manifest text for Business Time, 7');
    expect(host.textContent).toContain('Holding down the trigger');
    expect(host.textContent).not.toContain('Kills grant');
  });
  it('labels sandbox perk text with the perk name and hash, one block per perk', async () => {
    await show(3);
    expect(host.textContent).toContain('No description of its own. From its sandbox perks:');
    const terms = [...host.querySelectorAll('dt')].map((term) => term.textContent);
    expect(terms).toEqual(['Kinetic Siphon · 11', 'Shieldcrush · 12', 'Unnamed perk · 13']);
    expect(host.querySelectorAll('dd')[1].textContent).toBe(perks[12][1]);
  });
  it('says a stat-line perk once when its description repeats its name', async () => {
    useDataStore.setState({
      data: {
        ...useDataStore.getState().data!,
        items: { 8: item(8, { name: 'Facet', sandboxPerkHashes: [14, 12] }) },
      },
    });
    await show(8);
    expect([...host.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      '-10 Grenade ▼ · 14',
      'Shieldcrush · 12',
    ]);
    expect(host.querySelectorAll('dd')).toHaveLength(2);
    expect(host.querySelector('dd.sr-only')?.textContent).toBe('Same as the perk name.');
    expect(host.querySelectorAll('dd:not(.sr-only)')).toHaveLength(1);
    expect(host.textContent?.match(/-10 Grenade/g)).toHaveLength(1);
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Sandbox perks: While you have an overshield');
    expect(host.textContent).not.toContain('Sandbox perks: -10');
  });
  it('states that there is no manifest description', async () => {
    await show(4);
    expect(host.textContent).toContain('No manifest description.');
    await show(5);
    expect(host.textContent).toContain('none on its sandbox perk (99)');
    await show(404);
    expect(host.textContent).toContain('No manifest description.');
  });
  it('collapses to a one-line summary and remembers the choice', async () => {
    await show(1);
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('p')).toBeNull();
    expect(host.textContent).toContain('Kills grant increased damage. Stacks 3x.');
    expect(localStorage.getItem('clarity.manifestText.open')).toBe('0');
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(2);
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('Sandbox perk: Rapid Kinetic weapon final blows');
  });
  it('shows a loading line until the bundled perk text arrives, then the text', async () => {
    resetSandboxPerkText();
    let arrive!: (value: unknown) => void;
    void loadSandboxPerkText(() => new Promise((resolve) => (arrive = resolve)));
    await show(2);
    expect(host.textContent).toContain('Loading sandbox perk text…');
    await act(async () => arrive({ perks }));
    expect(host.textContent).toContain('Rapid Kinetic weapon final blows');
  });
  it('says so when the perk text cannot be loaded', async () => {
    resetSandboxPerkText();
    await act(async () => loadSandboxPerkText(() => Promise.reject(new Error('offline'))));
    await show(2);
    expect(host.textContent).toContain('the sandbox perk text failed to load');
    await show(1);
    expect(host.textContent).toContain('Kills grant increased damage.');
  });
});
