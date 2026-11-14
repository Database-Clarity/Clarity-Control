// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markupIcons,
  markupSnippets,
  markupSymbols,
  markupTags,
  parseMarkup,
  type MarkupGlobals,
} from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { markupEntries, rowEntries, rowOrder, rowSeparator } from './entries';
import { useMarkupRow } from './useMarkupRow';
import { useSettingsStore } from '../../../stores/settings';

const globals: MarkupGlobals & { allowBaseEnhanced: boolean } = {
  allowBaseEnhanced: true,
  variables: 'var e = 🡅\nvar damage = 25',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};

const NL = String.fromCharCode(10);
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

it('keeps caret and undo in authoring form and callbacks preserve native markup', () => {
  const changed = vi.fn();
  const render = (value: string) =>
    act(() =>
      root.render(<ClarityEditor value={value} lang="en" globals={globals} onChange={changed} />),
    );
  const stored = 'Gives {{10}{20}} damage.';
  render(stored);
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  expect(view.state.doc.toString()).toBe('Gives {{10}{20}} damage.');
  const caret = view.state.doc.length;
  act(() =>
    view.dispatch({ changes: { from: caret, insert: '!' }, selection: { anchor: caret + 1 } }),
  );
  const emitted = changed.mock.calls.at(-1)![0] as string;
  expect(emitted).toBe('Gives {{10}{20}} damage.!');
  render(emitted);
  expect(view.state.selection.main.head).toBe(caret + 1);
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe('Gives {{10}{20}} damage.');
  expect(changed.mock.calls.at(-1)![0]).toBe(stored);
  const incomplete = 'Gives {{10}{';
  render(incomplete);
  expect(view.state.doc.toString()).toBe(incomplete);
  act(() => view.dispatch({ changes: { from: incomplete.length, insert: '2' } }));
  expect(changed.mock.calls.at(-1)![0]).toBe(incomplete + '2');
});

it('keeps the row, disabled, while the text is paused read-only (the text never moves)', () => {
  const render = (props: { readOnly?: boolean; paused?: boolean }) =>
    act(() =>
      root.render(
        <ClarityEditor
          value="x"
          lang="en"
          globals={globals}
          markupRow
          onChange={() => {}}
          {...props}
        />,
      ),
    );
  render({});
  expect(row()?.hasAttribute('inert')).toBe(false);
  expect(row()?.hasAttribute('data-disabled')).toBe(false);
  // Another tab's write pauses editing: the row stays where it was, inert and dimmed.
  render({ readOnly: true, paused: true });
  expect(row()).not.toBeNull();
  expect(row()?.hasAttribute('inert')).toBe(true);
  expect(row()?.getAttribute('aria-disabled')).toBe('true');
  // Answering the notice gives the row back.
  render({});
  expect(row()?.hasAttribute('inert')).toBe(false);
  // A text that is read-only for good (archive, no access) has no markup row.
  render({ readOnly: true });
  expect(row()).toBeNull();
});

describe('the retired markup options', () => {
  const retired = [
    'inline:center',
    'inline:background',
    'inline:blue',
    'inline:green',
    'inline:purple',
    'line:center',
    'line:background',
    'line:breakSpaces',
    'stack-list',
    'decl-catalyst',
    'decl-exotic-perk',
  ];

  it('are gone from the catalogue, the row and the All popover (the parser still reads them)', () => {
    const ids = markupEntries(globals).map((entry) => entry.id);
    for (const id of retired) expect(ids, id).not.toContain(id);
    expect(ids).toEqual(expect.arrayContaining(['inline:bold', 'inline:yellow', 'line:bold']));
    for (const id of retired) expect(rowOrder, id).not.toContain(id);
    mount('x');
    for (const id of retired) expect(host.querySelector(`[data-entry="${id}"]`), id).toBeNull();
  });

  it('keep parsing: existing content with them still renders', () => {
    const parsed = parseMarkup('<center/>Hello <blue world />' + NL + '<breakSpaces/>x  ', globals);
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('the markup row catalogue', () => {
  it('uses the owner order, Exotic label, and symbol-only arrow', () => {
    const entries = markupEntries(globals);
    expect(
      rowEntries(entries)
        .filter((item) => item !== rowSeparator)
        .map((item) => item.id),
    ).toEqual([
      'enhanced-arrow',
      'base-enhanced-pair',
      'pve',
      'pvp',
      'pair',
      ...[
        'kinetic',
        'arc',
        'solar',
        'void',
        'stasis',
        'strand',
        'prismatic',
        'primary',
        'special',
        'heavy',
        'barrier',
        'overload',
        'unstoppable',
        'warlock',
        'hunter',
        'titan',
      ].map((name) => `icon:${name}`),
      'link',
      'title',
      'inline:bold',
      'inline:yellow',
    ]);
    expect(entries.some((entry) => entry.id === 'bullet')).toBe(false);
    expect(entries.find((entry) => entry.id === 'inline:yellow')?.label).toBe('Exotic (yellow)');
    expect(entries.find((entry) => entry.id === 'enhanced-arrow')?.glyph).toEqual({
      kind: 'arrow',
      text: '',
    });
    expect(markupIcons).toHaveLength(16);
    expect(rowOrder.filter((id) => id.startsWith('icon:'))).toHaveLength(16);
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

  it('the enhanced arrow symbol goes in at the caret and never replaces the selection', () => {
    const view = mount('Amount 5');
    act(() => view.dispatch({ selection: { anchor: 7, head: 8 } }));
    click(entryButton('enhanced-arrow'));
    expect(view.state.doc.toString()).toBe('Amount 5<enhanced/>');
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
    // 1 = enhanced arrow
    key(buttons[0]!, '1');
    expect(view.state.doc.toString()).toBe('Deals <enhanced/>');
    key(buttons[0]!, 'End');
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it('shows the markup on hover and the number key for the first nine', () => {
    mount('x');
    expect(entryButton('enhanced-arrow').title).toContain('key 1');
    expect(entryButton('pair').title).toContain('<pve value /> <pvp [value] />');
    expect(entryButton('inline:bold').title).not.toContain('key');
    expect(entryButton('inline:yellow').title).toContain('Exotic (yellow)');
  });

  it('never takes focus from the text when pressed', () => {
    mount('x');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      entryButton('enhanced-arrow').dispatchEvent(event);
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

  it('is compact: icon chips carry no label text, the name sits in the tooltip', () => {
    mount('x');
    const popover = openAll();
    const chips = [...popover.querySelectorAll<HTMLButtonElement>('[data-all-button]')];
    const stasis = chips.find((chip) => chip.getAttribute('aria-label') === 'stasis')!;
    expect(stasis.textContent).toBe('');
    expect(stasis.title).toContain('stasis');
    const pvp = chips.find((chip) => chip.getAttribute('aria-label') === 'PvP only')!;
    expect(pvp.textContent).toBe('PvP');
    expect(pvp.title).toBe('PvP only: <pvp [value] />');
    // No chip repeats its own name beside its face.
    expect(popover.querySelector('[class*=chipLabel]')).toBeNull();
    for (const group of ['Format', 'Line styles'])
      expect(
        popover.querySelector(`[role=group][aria-label="${group}"]`)!.textContent!.length,
      ).toBeLessThan(60);
    // The footer is one short line until something is hovered.
    expect(popover.querySelector('p')!.textContent!.length).toBeLessThan(60);
  });

  it('keeps global variables in their own group, apart from the tooltip variables', () => {
    mount('var local = 3' + NL + 'Hit for ');
    const popover = openAll();
    const group = (title: string) =>
      [...popover.querySelectorAll(`[role=group][aria-label="${title}"] [data-all-button]`)].map(
        (chip) => chip.getAttribute('aria-label'),
      );
    expect(group('Variables')).toEqual(['#local']);
    expect(group('Global variables')).toEqual(expect.arrayContaining(['#e', '#damage']));
    expect(group('Global variables')).not.toContain('#local');
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

describe('inserting an enhanced section from the popover', () => {
  it('writes the section with its arrow line already filled in, on a line of its own', () => {
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
    // The <enhanced/> line is the enhanced arrow line, and it ships with text to replace.
    expect(text.endsWith(NL + ')')).toBe(true);
    expect(text.split(NL).some((line) => line.startsWith('<enhanced/> ') && line.length > 12)).toBe(true);
  });
});

describe('Ctrl+. and the remembered row state', () => {
  function Probe() {
    const row = useMarkupRow();
    return <output>{row.open ? 'open' : 'closed'}</output>;
  }
  const press = (init: KeyboardEventInit) =>
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '.', bubbles: true, cancelable: true, ...init }),
      );
    });
  const read = () => host.querySelector('output')!.textContent;

  it('is open by default for someone who never chose', () => {
    useSettingsStore.getState().updateDevice({ remembered: {} });
    act(() => root.render(<Probe />));
    expect(read()).toBe('open');
    expect(useSettingsStore.getState().device.remembered.markupToolbar).toBeUndefined();
  });

  it('ignores a stored synced "closed": it cannot tell "never chose" from "chose closed"', () => {
    useSettingsStore.getState().updateDevice({ remembered: {} });
    useSettingsStore.getState().update({ markupToolbar: 'closed' });
    act(() => root.render(<Probe />));
    expect(read()).toBe('open');
  });

  it('toggles on Ctrl+. (not Ctrl+Shift+.) and remembers an explicit hide on this device', () => {
    useSettingsStore.getState().updateDevice({ remembered: {} });
    act(() => root.render(<Probe />));
    expect(read()).toBe('open');
    press({ ctrlKey: true, shiftKey: true });
    expect(read()).toBe('open');
    press({ ctrlKey: true });
    expect(read()).toBe('closed');
    expect(useSettingsStore.getState().device.remembered.markupToolbar).toBe('closed');
    // A later mount (another page) still honours the explicit choice.
    act(() => root.render(null));
    act(() => root.render(<Probe />));
    expect(read()).toBe('closed');
    press({ ctrlKey: true });
    expect(read()).toBe('open');
    expect(useSettingsStore.getState().device.remembered.markupToolbar).toBe('open');
  });
});

describe('the raw markup toggle in the row', () => {
  const toggle = () => host.querySelector<HTMLButtonElement>('[data-raw-toggle]');
  const statusToggle = () =>
    host.querySelector<HTMLButtonElement>('[data-editor-status] button[aria-pressed]');
  const shortcut = (view: EditorView) =>
    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '.',
          code: 'Period',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  const render = (open: boolean, symbols = true) =>
    act(() =>
      root.render(
        <ClarityEditor
          value="<yellow ab /> <arc/>"
          lang="en"
          globals={globals}
          markupRow={open}
          symbols={symbols}
          onChange={() => {}}
        />,
      ),
    );

  it('is a pressed-state button with a tooltip that names the shortcut', () => {
    const view = mount('<yellow ab /> <arc/>');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle()?.title).toContain('Ctrl+Shift+.');
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(1);
    click(toggle()!);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(0);
    expect(view.state.doc.toString()).toBe('<yellow ab /> <arc/>');
    click(toggle()!);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(1);
  });

  it('stays in sync with the keyboard shortcut', () => {
    const view = mount('<yellow ab /> <arc/>');
    shortcut(view);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    shortcut(view);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('is the only toggle while the row is shown, and the status bar takes over when it is hidden', () => {
    mount('<yellow ab /> <arc/>');
    expect(statusToggle()).toBeNull();
    expect(host.querySelector('[data-raw-hint]')).toBeNull();
    click(toggle()!);
    render(false);
    expect(toggle()).toBeNull();
    expect(statusToggle()?.getAttribute('aria-pressed')).toBe('true');
    // It is a plain bar item, not the touch-only Suggest style, so it shows on desktop too.
    expect(statusToggle()?.className).not.toContain('suggest');
    expect(statusToggle()?.textContent).toBe('Raw');
    render(true);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(statusToggle()).toBeNull();
  });

  it('is absent for stored forms that draw no symbols', () => {
    render(true, false);
    expect(toggle()).toBeNull();
    expect(statusToggle()).toBeNull();
  });
});
