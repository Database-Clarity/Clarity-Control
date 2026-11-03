// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markupIcons,
  markupSnippets,
  markupSymbols,
  markupTags,
  type MarkupGlobals,
} from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { markupEntries, rowEntries, rowOrder, rowSeparator } from './entries';
import { useMarkupRow } from './useMarkupRow';
import { useSettingsStore } from '../../../stores/settings';

const globals: MarkupGlobals = {
  variables: 'var e = 🡅\nvar damage = 25',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no layout: the caret is "at" a fixed spot inside a window-sized editor.
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 40,
    right: 41,
    top: 100,
    bottom: 116,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 800,
    top: 0,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('[role=dialog]').forEach((node) => node.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(doc: string, open = true) {
  act(() =>
    root.render(
      <ClarityEditor
        value={doc}
        lang="en"
        globals={globals}
        markupRow={open}
        onChange={() => {}}
      />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  return view;
}
const row = () => host.querySelector<HTMLElement>('[data-markup-row]');
const rowButtons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-row-button]')];
const entryButton = (id: string) => host.querySelector<HTMLButtonElement>(`[data-entry="${id}"]`)!;
const click = (node: HTMLElement) =>
  act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('the markup row catalogue', () => {
  it('is ordered: bullet, pair, PvE, PvP, 15 icons, enhanced arrow, link, title, bold + 4 colours, line styles', () => {
    const ids = rowEntries(markupEntries(globals)).map((item) =>
      item === rowSeparator ? '|' : item.id,
    );
    expect(ids).toEqual([
      'bullet',
      '|',
      'pair',
      'pve',
      'pvp',
      '|',
      ...markupIcons.map((name) => `icon:${name}`),
      '|',
      'enhanced-arrow',
      'link',
      'title',
      '|',
      'inline:bold',
      'inline:yellow',
      'inline:blue',
      'inline:green',
      'inline:purple',
      '|',
      'inline:center',
      'inline:background',
    ]);
    expect(markupIcons).toHaveLength(15);
    expect(rowOrder.filter((id) => id.startsWith('icon:'))).toHaveLength(15);
  });

  it('offers separate PvE and PvP tags next to the pair preset, and no tables anywhere', () => {
    const entries = markupEntries(globals);
    const markup = (id: string) => entries.find((entry) => entry.id === id)?.markup;
    expect(markup('pair')).toBe('<pve value /> <pvp [value] />');
    expect(markup('pve')).toBe('<pve value />');
    expect(markup('pvp')).toBe('<pvp [value] />');
    for (const entry of entries) {
      expect(`${entry.id} ${entry.label} ${entry.markup} ${entry.group}`.toLowerCase()).not.toMatch(
        /table/,
      );
    }
  });

  it('reuses the suggestion catalogue: every symbol, format tag and value snippet is in the list', () => {
    const entries = markupEntries(globals);
    const ids = new Set(entries.map((entry) => entry.id));
    for (const symbol of markupSymbols) {
      expect(ids.has(symbol.id.startsWith('style:') ? `line:${symbol.name}` : symbol.id)).toBe(
        true,
      );
    }
    for (const id of [
      'pair',
      'pve',
      'pvp',
      'pvp-override',
      'stack-list',
      'enhanced-block',
      'enhanced-formula',
      'icon-word',
    ])
      expect(ids.has(id)).toBe(true);
    // Every tag the menu lists as Tags is reachable (pve/pvp as their own entries).
    for (const tag of markupTags) {
      const name = tag.id.replace('tag:', '');
      expect(ids.has(name) || ids.has(`inline:${name}`) || ids.has(name)).toBe(true);
    }
    expect(markupSnippets.some((snippet) => snippet.id === 'enhanced-block')).toBe(true);
  });
});

describe('the markup row', () => {
  it('is hidden when closed and 30px tall (one line) when open', () => {
    mount('Gains ', false);
    expect(row()).toBeNull();
    mount('Gains ', true);
    expect(row()).not.toBeNull();
    expect(rowButtons()).toHaveLength(
      rowEntries(markupEntries(globals)).filter((item) => item !== rowSeparator).length,
    );
    // One line: no wrapping flex container.
    expect(row()!.querySelector('[role=toolbar]')).not.toBeNull();
  });

  it('inserts at the caret, keeps the text focus and puts the caret after the markup', () => {
    const view = mount('Deals ');
    click(entryButton('icon:kinetic'));
    expect(view.state.doc.toString()).toBe('Deals <kinetic/>');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('wraps the selection and leaves the selected value to type over', () => {
    const view = mount('Deals 90 damage');
    act(() => view.dispatch({ selection: { anchor: 6, head: 8 } }));
    click(entryButton('pve'));
    expect(view.state.doc.toString()).toBe('Deals <pve 90 /> damage');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      '90',
    );
  });

  it('writes the pair preset and the separate PvE and PvP tags', () => {
    const view = mount('x ');
    click(entryButton('pair'));
    expect(view.state.doc.toString()).toBe('x <pve value /> <pvp [value] />');
    const second = mount('y ');
    click(entryButton('pvp'));
    expect(second.state.doc.toString()).toBe('y <pvp [value] />');
  });

  it('puts a bullet at the start of every selected line, once', () => {
    const view = mount('one\ntwo\n• three');
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    click(entryButton('bullet'));
    expect(view.state.doc.toString()).toBe('• one\n• two\n• three');
    click(entryButton('bullet'));
    expect(view.state.doc.toString()).toBe('• one\n• two\n• three');
  });

  it('the enhanced arrow is plain #e at the caret and never replaces the selection', () => {
    const view = mount('Amount 5');
    act(() => view.dispatch({ selection: { anchor: 7, head: 8 } }));
    click(entryButton('enhanced-arrow'));
    expect(view.state.doc.toString()).toBe('Amount 5#e');
  });

  it('says why when the document refuses an insertion, and changes nothing', () => {
    const view = mount('<bold word />');
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    click(entryButton('icon:solar'));
    expect(view.state.doc.toString()).toBe('<bold word />');
    expect(host.querySelector('[role=status]')?.textContent).toMatch(/Cannot insert markup/);
  });

  it('arrow keys move along the row, a number key inserts, and Esc returns to the text', () => {
    const view = mount('Deals ');
    const buttons = rowButtons();
    buttons[0]!.focus();
    const key = (target: HTMLElement, name: string) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
        );
      });
    key(buttons[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1]!, 'ArrowLeft');
    expect(document.activeElement).toBe(buttons[0]);
    // 1 = bullet
    key(buttons[0]!, '1');
    expect(view.state.doc.toString()).toBe('• Deals ');
    key(buttons[0]!, 'End');
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it('shows the markup on hover and the number key for the first nine', () => {
    mount('x');
    expect(entryButton('bullet').title).toContain('key 1');
    expect(entryButton('pair').title).toContain('<pve value /> <pvp [value] />');
    expect(entryButton('inline:bold').title).not.toContain('key');
  });

  it('never takes focus from the text when pressed', () => {
    mount('x');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      entryButton('bullet').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('the All popover', () => {
  const openAll = () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === 'All',
    )!;
    click(button);
    return document.body.querySelector<HTMLElement>('[data-all-popover]')!;
  };

  it('lists every option grouped, with no tables, and filters', () => {
    mount('x');
    const popover = openAll();
    const titles = [...popover.querySelectorAll('[role=group]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(titles).toEqual(
      expect.arrayContaining([
        'Values',
        'Icons',
        'Enhanced',
        'Format',
        'Line styles',
        'References',
      ]),
    );
    expect(popover.textContent?.toLowerCase()).not.toContain('table');
    const all = popover.querySelectorAll('[data-all-button]');
    expect(all.length).toBeGreaterThan(rowButtons().length);
    const filter = popover.querySelector<HTMLInputElement>('input')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(filter, 'stasis');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const left = [...popover.querySelectorAll('[data-all-button]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(left).toContain('stasis');
    expect(left.length).toBeLessThan(all.length);
  });

  it('lists the document and global variables, and inserts a choice then closes', () => {
    const view = mount('Hit for ');
    const popover = openAll();
    const damage = [...popover.querySelectorAll<HTMLButtonElement>('[data-all-button]')].find(
      (node) => node.getAttribute('aria-label') === '#damage',
    )!;
    expect(damage).toBeTruthy();
    click(damage);
    expect(view.state.doc.toString()).toBe('Hit for #damage');
    expect(document.body.querySelector('[data-all-popover]')).toBeNull();
  });
});

const NL = String.fromCharCode(10);

describe('inserting an enhanced section from the popover', () => {
  it('writes the section with its #e arrow line already filled in, on a line of its own', () => {
    const view = mount('Reload speed up.');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === 'All',
    )!;
    click(button);
    const section = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[data-all-button]'),
    ].find((node) => node.getAttribute('aria-label') === 'Enhanced section')!;
    click(section);
    const text = view.state.doc.toString();
    expect(text.startsWith('Reload speed up.' + NL + 'enhanced (' + NL)).toBe(true);
    // The #e line is the enhanced arrow line, and it ships with text to replace.
    expect(text.endsWith(NL + ')')).toBe(true);
    expect(text.split(NL).some((line) => line.startsWith('#e ') && line.length > 3)).toBe(true);
  });
});

describe('Ctrl+. and the remembered row state', () => {
  function Probe() {
    const row = useMarkupRow();
    return <output>{row.open ? 'open' : 'closed'}</output>;
  }
  it('toggles on Ctrl+. (not Ctrl+Shift+.) and persists the last choice on this device', () => {
    useSettingsStore.getState().updateDevice({ remembered: {} });
    useSettingsStore.getState().update({ markupToolbar: 'closed' });
    act(() => root.render(<Probe />));
    const read = () => host.querySelector('output')!.textContent;
    expect(read()).toBe('closed');
    const press = (init: KeyboardEventInit) =>
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: '.', bubbles: true, cancelable: true, ...init }),
        );
      });
    press({ ctrlKey: true });
    expect(read()).toBe('open');
    expect(useSettingsStore.getState().device.remembered.markupToolbar).toBe('open');
    press({ ctrlKey: true, shiftKey: true });
    expect(read()).toBe('open');
    press({ ctrlKey: true });
    expect(read()).toBe('closed');
    // The synced default is untouched: the remembered choice is per device.
    expect(useSettingsStore.getState().settings.markupToolbar).toBe('closed');
  });
});
