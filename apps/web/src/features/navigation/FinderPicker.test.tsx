// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinderPicker, type PickerSection } from './FinderPicker';

let host: HTMLDivElement;
let root: Root;
const change = vi.fn();
const sections: PickerSection[] = [
  {
    label: 'Armor',
    options: [
      { id: 'helm', label: 'Helmet', icon: '/common/a.png' },
      { id: 'gauntlets', label: 'Gauntlets' },
    ],
  },
  {
    label: 'Weapons',
    options: [
      { id: 'gun', label: 'Gun' },
      { id: 'glaive', label: 'Glaive' },
    ],
  },
];
const trigger = () => host.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const active = () => document.getElementById(trigger().getAttribute('aria-activedescendant') ?? '');
async function key(name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => void trigger().dispatchEvent(event));
  return event;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  change.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <FinderPicker
        label="Category"
        sections={sections}
        value="gauntlets"
        onChange={change}
        icons
      />,
    ),
  );
  trigger().focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('FinderPicker', () => {
  it('is a closed select-only combobox showing the value, with no text field', () => {
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().textContent).toBe('Gauntlets');
    expect(document.querySelector('input')).toBeNull();
    expect(listbox()).toBeNull();
  });

  it('opens on ArrowDown at the current option, in labelled groups, with icon boxes', async () => {
    await key('ArrowDown');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(listbox()!.id);
    expect(active()?.textContent).toBe('Gauntlets');
    expect(active()?.getAttribute('aria-selected')).toBe('true');
    const groups = [...listbox()!.querySelectorAll('[role="group"]')];
    expect(
      groups.map(
        (group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent,
      ),
    ).toEqual(['Armor', 'Weapons']);
    // Every row has the icon box; only a row with an icon has an image.
    expect(listbox()!.querySelectorAll('[role="option"] > span[aria-hidden]')).toHaveLength(4);
    // The image itself arrives just after the list first paints.
    expect(listbox()!.querySelectorAll('img')).toHaveLength(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(listbox()!.querySelectorAll('img')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger());
  });

  it('moves with arrows and Home/End, and Enter chooses', async () => {
    await key('Enter');
    await key('ArrowDown');
    expect(active()?.textContent).toBe('Gun');
    await key('End');
    expect(active()?.textContent).toBe('Glaive');
    await key('Home');
    expect(active()?.textContent).toBe('Helmet');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    expect(change).toHaveBeenCalledWith('gun');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('type-ahead jumps by the typed prefix and cycles one repeated letter', async () => {
    await key('ArrowDown');
    await key('g', { timeStamp: 1 } as KeyboardEventInit);
    expect(active()?.textContent).toBe('Gun');
    await key('g');
    expect(active()?.textContent).toBe('Glaive');
  });

  it('Escape closes only the list, keeps the value, and does not bubble', async () => {
    await key('ArrowDown');
    await key('ArrowDown');
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    const event = await key('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
    expect(listbox()).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it('a click on an option chooses it; choosing the current value reports nothing', async () => {
    await act(async () => trigger().click());
    const gauntlets = listbox()!.querySelector<HTMLElement>('[data-value="gauntlets"]')!;
    await act(async () => gauntlets.click());
    expect(change).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    await act(async () => listbox()!.querySelector<HTMLElement>('[data-value="helm"]')!.click());
    expect(change).toHaveBeenCalledWith('helm');
  });
});
