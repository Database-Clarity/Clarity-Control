// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore, type EditorData } from '../../stores/data';
import type { Item } from '../../services/generatorSchema';
import { ManifestTextRow } from './ManifestTextRow';
import { resetNamesForTests, useNamesStore } from '../terms/names';
import {
  loadSandboxPerkText,
  manifestSummary,
  manifestText,
  manifestWordDiff,
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
  8: item(8, {
    baseHash: 1,
    inGameDescription: 'Kills grant greatly increased damage.\nStacks 3x.',
  }),
  9: item(9, {
    baseHash: 7,
    inGameDescription: 'Holding down the trigger boosts rate of fire and range.',
  }),
  10: item(10, { baseHash: 2, sandboxPerkHashes: [12] }),
  11: item(11, { baseHash: 1, inGameDescription: 'Another enhanced variant.' }),
  20: item(20, { enhancedHash: 21, inGameDescription: 'Frame text.' }),
  21: item(21, { baseHash: 20, inGameDescription: 'Enhanced frame text.' }),
  30: item(30, { inGameDescription: 'Reloading grants bonus handling for a short time.' }),
  31: item(31, { baseHash: 30, inGameDescription: 'Final blows blind nearby combatants.' }),
  32: item(32, { inGameDescription: 'Base text only.' }),
  33: item(33, { baseHash: 32 }),
};

describe('manifestText', () => {
  it('groups changed phrases and separates deletion from insertion', () => {
    const parts = manifestWordDiff(
      'Reduces recoil deviation for the weapon.',
      'Greatly improves recoil direction.',
    );
    expect(parts.map((part) => part.text).join('')).not.toContain('ReducesGreatly');
    expect(
      parts
        .filter((part) => part.kind === 'delete')
        .map((part) => part.text)
        .join(''),
    ).toContain('deviation for the weapon.');
    expect(
      parts
        .filter((part) => part.kind === 'insert')
        .map((part) => part.text)
        .join(''),
    ).toContain('direction.');
  });
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
    resetNamesForTests();
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
    resetNamesForTests();
  });
  const show = (hash: number) => act(async () => root.render(<ManifestTextRow hash={hash} />));
  // Diff marks in the text, not the legend's sample marks.
  const mark = (tag: 'ins' | 'del') => host.querySelector(`p:not([data-legend]) > ${tag}`);

  it('merges a pair into one text, and falls back to old then new for a rewrite', async () => {
    await show(1);
    const text = () => host.querySelector('p:not([data-legend]):last-of-type')!;
    // Unchanged words appear once; only the enhanced-only word is marked.
    expect(text().textContent).toBe('Kills grant greatly increased damage.\nStacks 3x.');
    expect(host.textContent!.split('Stacks 3x.')).toHaveLength(2);
    expect(mark('ins')?.textContent?.trim()).toBe('greatly');
    expect(mark('del')).toBeNull();
    expect(host.querySelector('[data-legend]')?.textContent).toBe('Base only Enhanced only');
    expect(host.textContent).not.toContain('Enhanced:');
    await show(30);
    const blocks = [...host.querySelectorAll('p:not([data-legend])')];
    expect(blocks.map((block) => block.textContent)).toEqual([
      'Reloading grants bonus handling for a short time.',
      'Final blows blind nearby combatants.',
    ]);
    expect(blocks[0].querySelector('del')?.textContent).toBe(blocks[0].textContent);
    expect(blocks[1].querySelector('ins')?.textContent).toBe(blocks[1].textContent);
  });

  it('keeps the base text when the enhanced side has none', async () => {
    await show(32);
    expect(host.textContent).toContain('Base text only.');
    expect(host.textContent).toContain('Enhanced: no manifest text');
    expect(host.querySelector('del, ins')).toBeNull();
  });

  it('shows both sides of a pair, diffs words, and captions identical text', async () => {
    await show(1);
    expect(mark('ins')?.textContent).toContain('greatly');
    await show(8);
    expect(mark('ins')?.textContent).toContain('greatly');
    await show(9);
    expect(host.textContent).toContain('Enhanced: same text');
    expect(mark('ins')).toBeNull();
    await show(4);
    expect(host.textContent).not.toContain('Enhanced');
    expect(host.textContent).not.toContain('Kills grant');
  });

  it('diffs the sandbox fallback for both members of a pair', async () => {
    await show(2);
    expect(host.textContent).toContain(perks[11][1]);
    expect(mark('del')?.textContent).toContain('Rapid');
    expect(mark('ins')?.textContent).toContain('While');
    await show(4);
    expect(mark('del')).toBeNull();
  });

  it('follows the preview variant picker, and resets the pair when stepping away', async () => {
    await act(async () => root.render(<ManifestTextRow hash={1} enhancedHash={11} />));
    expect(mark('ins')?.textContent).toContain('Another');
    await act(async () => root.render(<ManifestTextRow hash={1} enhancedHash={8} />));
    expect(mark('ins')?.textContent).toContain('greatly');
    expect(host.textContent).not.toContain('Another');
    await show(4);
    expect(mark('ins')).toBeNull();
  });

  it('uses the generator primary enhanced frame even when editing aliases hide it', async () => {
    useDataStore.setState((state) => ({
      data: { ...state.data!, aliases: { 21: { to: 20, kind: 'frame' } } },
    }));
    await show(20);
    expect(mark('ins')?.textContent).toContain('Enhanced');
    await show(21);
    expect(mark('ins')?.textContent).toContain('Enhanced');
  });

  it('localises arriving text, preserves missing rows, and clears it when switching to English', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await act(async () => root.render(<ManifestTextRow hash={1} lang="de" />));
    expect(host.textContent).toContain('Kills grant');
    await act(async () =>
      useNamesStore.setState({
        byLang: {
          de: {
            status: 'ready',
            file: {
              v: 1,
              lang: 'de',
              manifestVersion: 'm1',
              names: {},
              itemNames: {},
              setNames: {},
              descriptions: { 1: 'Besiegte Gegner erhöhen den Schaden.' },
              sandboxPerks: {
                11: ['Kinetischer Siphon', 'Schnelle Abschüsse erzeugen eine Sphäre.'],
              },
            },
          },
        },
      }),
    );
    expect(host.querySelector('p button')?.textContent).toBe(
      'Besiegte Gegner erhöhen den Schaden.',
    );
    expect(host.querySelector('p button')?.hasAttribute('title')).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('p button')!.focus());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Kills grant');
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await act(async () => root.render(<ManifestTextRow hash={3} lang="de" />));
    expect(host.textContent).toContain('Kinetischer Siphon');
    expect(host.textContent).toContain('Schnelle Abschüsse');
    expect(host.textContent).toContain('While you have an overshield');
    expect(host.textContent).not.toContain('Besiegte Gegner');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Schnelle Abschüsse');
    await act(async () => root.render(<ManifestTextRow hash={1} lang="en" />));
    expect(host.textContent).toContain('Kills grant');
    expect(host.textContent).not.toContain('Besiegte Gegner');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is open by default with the name, hash, and description, and follows the entry', async () => {
    await show(1);
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    const label = () => host.querySelector('section')?.getAttribute('aria-label');
    expect(label()).toBe('Manifest text for Rampage, 1');
    expect(host.textContent).toContain('Kills grant greatly increased damage.');
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
    expect(host.textContent).toContain('Kills grant greatly increased damage.');
  });
});
