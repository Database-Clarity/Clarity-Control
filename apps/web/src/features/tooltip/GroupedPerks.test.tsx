// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSandboxPerkText, resetSandboxPerkText } from '../manifest/manifestText';
import { GroupedPerks } from './EditorPaneHeader';
import type { GroupedPerk } from './grouping';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  resetSandboxPerkText();
});

const perk = (hash: number, name: string, how: string): GroupedPerk => ({
  hash,
  name,
  enhanced: false,
  reason: name ? 'canonical' : 'sandbox',
  how,
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
            perk(1888882410, 'Collective Pugilism', 'Canonical'),
            perk(411682304, '', 'Sandbox alias'),
            perk(5, '', 'Sandbox alias'),
            perk(7, '', 'Sandbox alias'),
            { ...perk(8, '', 'Alias group'), reason: 'alias' },
          ]}
        />,
      ),
    );
    const name = (hash: number) => host.querySelector(`[data-grouped="${hash}"] span`)?.textContent;
    expect(name(1888882410)).toBe('Collective Pugilism');
    expect(name(411682304)).toBe('Collective Pugilism');
    expect(name(5)).toBe('Unnamed sandbox perk');
    // A blank sandbox definition is still a manifest sandbox perk.
    expect(name(7)).toBe('Unnamed sandbox perk');
    expect(name(8)).toBe('Not in the manifest catalog');
  });

  it('does not call a sandbox perk unnamed when its text failed to load', async () => {
    await loadSandboxPerkText(() => Promise.reject(new Error('offline')));
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root!.render(
        <GroupedPerks
          perks={[
            perk(1888882410, 'Collective Pugilism', 'Canonical'),
            perk(411682304, '', 'Sandbox alias'),
          ]}
        />,
      ),
    );
    const name = (hash: number) => host.querySelector(`[data-grouped="${hash}"] span`)?.textContent;
    expect(name(1888882410)).toBe('Collective Pugilism');
    expect(name(411682304)).toBe('Name unavailable');
  });
});
