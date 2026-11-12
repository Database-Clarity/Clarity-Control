// @vitest-environment jsdom
// "Group with icon" and the keyword chip (ELEMENT-TAGS-3): an existing `<solar/>Word` pair becomes
// one tagged span from Ctrl+Space, the icon's popover, or Alt+Enter; a spaced pair asks before it
// drops the space; an icon just inserted before its element's keyword offers to tag them together.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lowerElementTags, type MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { useDataStore, type EditorData } from '../../stores/data';
import { groupChange, linePairs, pairAt } from './iconPairs';
import { insertMarkup, markupOptions } from './markupInsertion';
import {
  acceptChip,
  chipHost,
  chipState,
  chipsExtension,
  dismissChip,
  markChipShown,
} from './markupRow/chips';
import { requestItems, suggestContext } from './suggest/source';
import {
  acceptSuggestion,
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  suggestState,
} from './suggest/state';

// The element comes from the description ([Solar]); no manifest plug categories.
vi.mock('../compendium/manifestFacts', async (original) => {
  const real = await original<typeof import('../compendium/manifestFacts')>();
  return { ...real, loadManifestFacts: () => ({ ...real.loadManifestFacts(), items: {} }) };
});

const globals: MarkupGlobals = { variables: '', titles: '' };

/** Catalogue names with their element (from the in-game description). */
function catalogue(names: [string, string][]) {
  useDataStore.setState({
    data: {
      categories: [],
      aliases: {},
      items: Object.fromEntries(
        names.map(([name, element], i) => [
          i + 100,
          {
            hash: i + 100,
            name,
            icon: '',
            categoryId: 'subclass-fragment',
            inGameDescription: `[${element}]`,
          },
        ]),
      ),
      bundle: { tooltips: {} },
    } as unknown as EditorData,
  });
}
afterEach(() => useDataStore.setState({ data: null }));

const at = (doc: string, from: number, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.range(from, to) });
const caretIn = (doc: string, word: string) => at(doc, doc.indexOf(word) + 1);
const grouped = (doc: string, word: string) => {
  const state = caretIn(doc, word);
  const pair = pairAt(state);
  const change = pair && groupChange(state, pair, globals);
  if (!change) return null;
  return {
    text: doc.slice(0, change.from) + change.insert + doc.slice(change.to),
    dropsSpace: change.dropsSpace,
  };
};

describe('group rules', () => {
  it('a joined pair groups and lowers to exactly the old text', () => {
    const doc = 'Gain <solar/>Scorch stacks.';
    expect(grouped(doc, 'Scorch')).toEqual({
      text: 'Gain <solar Scorch /> stacks.',
      dropsSpace: false,
    });
    expect(lowerElementTags(grouped(doc, 'Scorch')!.text)).toBe(doc);
  });

  it('a spaced pair groups only by dropping the space', () => {
    expect(grouped('Gain <void/> Breach now', 'Breach')).toEqual({
      text: 'Gain <void Breach /> now',
      dropsSpace: true,
    });
  });

  it('takes a whole known keyword of the element, else one word', () => {
    catalogue([
      ['Ionic Trace', 'Arc'],
      ['Void Breach', 'Void'],
    ]);
    expect(grouped('Make <arc/>Ionic Trace now', 'Ionic')?.text).toBe(
      'Make <arc Ionic Trace /> now',
    );
    // Another element's keyword is not taken whole.
    expect(grouped('Make <solar/>Void Breach now', 'Void')?.text).toBe(
      'Make <solar Void /> Breach now',
    );
    expect(grouped("Hit <arc/>Jolt's target", 'Jolt')?.text).toBe("Hit <arc Jolt's /> target");
  });

  it('the caret on the icon, in the word, or either selected finds the pair; elsewhere none', () => {
    const doc = 'Gain <solar/>Scorch stacks.';
    const icon = doc.indexOf('<solar/>');
    const word = doc.indexOf('Scorch');
    for (const [from, to] of [
      [icon, icon],
      [icon + 3, icon + 3],
      [word + 6, word + 6],
      [icon, word],
      [word, word + 6],
      [icon, word + 6],
    ] as const)
      expect(pairAt(at(doc, from, to))?.text).toBe('Scorch');
    expect(pairAt(at(doc, 2))).toBeNull();
    expect(pairAt(at(doc, word + 7))).toBeNull();
    // An icon before a non-letter is no pair.
    expect(linePairs(at('<arc/>10% <arc/> ', 0), 0)).toEqual([]);
  });

  it('refuses where a selection could not be tagged', () => {
    expect(grouped('Gain <yellow <solar/>Scorch /> now', 'Scorch')).toBeNull();
    expect(grouped('var x = <solar/>Scorch', 'Scorch')).toBeNull();
    expect(grouped('<solar Big <solar/>Scorch />', 'Scorch')).toBeNull();
  });
});

describe('in the editor', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSettingsStore.getState().updateDevice({ symbolReveal: 'popover' });
    // jsdom draws nothing: CodeMirror's caret measurements get empty boxes.
    const rects = () => Object.assign([] as DOMRect[], { item: () => null });
    Range.prototype.getClientRects = rects as unknown as Range['getClientRects'];
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  function Host({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <ClarityEditor markupRow value={value} lang="en" globals={globals} onChange={setValue} />
    );
  }
  function mount(value: string) {
    act(() => root.render(<Host initial={value} />));
    return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  }
  const key = (view: EditorView, init: KeyboardEventInit) =>
    act(
      () =>
        void runScopeHandlers(
          view,
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
          'editor',
        ),
    );
  const popover = () => host.querySelector<HTMLElement>('.cm-symbol-popover');
  const popoverButton = (label: string) =>
    [...(popover()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === label,
    );

  it('Alt+Enter groups a joined pair as one undo step', () => {
    const view = mount('Gain <solar/>Scorch stacks.');
    act(() => view.dispatch({ selection: { anchor: 15 } }));
    key(view, { key: 'Enter', altKey: true });
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> stacks.');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('Gain <solar/>Scorch stacks.');
  });

  it('a spaced pair asks beside the control; Escape keeps the space, Enter groups', () => {
    const view = mount('Gain <void/> Breach now');
    act(() => view.dispatch({ selection: { anchor: 16 } }));
    key(view, { key: 'Enter', altKey: true });
    // Nothing changed yet: the icon is selected and its popover asks.
    expect(view.state.doc.toString()).toBe('Gain <void/> Breach now');
    expect(popover()?.querySelector('.cm-symbol-ask')?.textContent).toBe(
      'Drop the space before “Breach”?',
    );
    key(view, { key: 'Escape' });
    expect(popover()?.querySelector('.cm-symbol-ask')).toBeFalsy();
    expect(view.state.doc.toString()).toBe('Gain <void/> Breach now');
    act(() => view.dispatch({ selection: { anchor: 16 } }));
    key(view, { key: 'Enter', altKey: true });
    key(view, { key: 'Enter' });
    expect(view.state.doc.toString()).toBe('Gain <void Breach /> now');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('Gain <void/> Breach now');
  });

  it("the icon's popover offers Group with icon; a spaced pair's Cancel keeps it", () => {
    const view = mount('Gain <solar/>Scorch and <arc/> Jolt.');
    act(() => view.dispatch({ selection: { anchor: 5, head: 13 } }));
    expect(popoverButton('Group with icon')?.title).toBe(
      'Tag “Scorch” as Solar: <solar Scorch /> (Alt+Enter)',
    );
    act(() => popoverButton('Group with icon')!.click());
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> and <arc/> Jolt.');
    const icon = view.state.doc.toString().indexOf('<arc/>');
    act(() => view.dispatch({ selection: { anchor: icon, head: icon + 6 } }));
    act(() => popoverButton('Group with icon')!.click());
    expect(popoverButton('Group')).toBeTruthy();
    act(() => popoverButton('Cancel')!.click());
    expect(popoverButton('Group with icon')).toBeTruthy();
    act(() => popoverButton('Group with icon')!.click());
    act(() => popoverButton('Group')!.click());
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> and <arc Jolt />.');
  });

  it('Ctrl+Space lists Group with icon first at a pair; a spaced one asks', () => {
    const view = mount('Gain <solar/>Scorch and <arc/> Jolt.');
    act(() => view.dispatch({ selection: { anchor: 16 } }));
    act(() => openSuggest(view));
    const menu = suggestState(view.state)!;
    expect(menu.items[menu.index]).toMatchObject({
      label: 'Group with icon',
      group: 'joined',
      insert: '<solar Scorch />',
    });
    act(() => void acceptSuggestion(view));
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> and <arc/> Jolt.');
    const jolt = view.state.doc.toString().indexOf('Jolt');
    act(() => view.dispatch({ selection: { anchor: jolt + 2 } }));
    act(() => openSuggest(view));
    expect(suggestState(view.state)!.items[0]).toMatchObject({ group: 'spaced' });
    act(() => void acceptSuggestion(view));
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> and <arc/> Jolt.');
    expect(popover()?.querySelector('.cm-symbol-ask')).toBeTruthy();
    key(view, { key: 'Enter' });
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> and <arc Jolt />.');
  });

  it('no Group entry where the selection is exactly the words (the wraps do it) or no pair', () => {
    const doc = 'Gain <solar/>Scorch now';
    const words = at(doc, 13, 19);
    expect(requestItems(suggestContext(words, true)!, words, globals)[0]?.label).not.toBe(
      'Group with icon',
    );
    const plain = at('Gain Scorch now', 6);
    expect(
      requestItems(suggestContext(plain, true)!, plain, globals).some((item) => item.group),
    ).toBe(false);
  });
});

describe('keyword chip', () => {
  const solar = markupOptions.find((option) => option.id === 'icon:solar')!;
  const arc = markupOptions.find((option) => option.id === 'icon:arc')!;
  function editor(doc: string, caret: number) {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [
          history(),
          chipsExtension(),
          suggestExtension(),
          suggestConfiguration({ globals }),
          chipHost.of({ globals, acceptKey: () => 'enter' }),
        ],
      }),
    });
  }

  it('an icon inserted before its keyword offers to tag them; accepting is one tag', () => {
    catalogue([['Firesprite', 'Solar']]);
    const view = editor('Gain Firesprite now', 5);
    try {
      expect(insertMarkup(view, solar, globals)).toBe('inserted');
      expect(chipState(view.state)).toMatchObject({
        text: 'Tag “Firesprite” as Solar',
        markup: '<solar Firesprite />',
        covers: { from: 5, to: 5 + '<solar/>Firesprite'.length },
      });
      markChipShown(view, true);
      expect(acceptChip(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('Gain <solar Firesprite /> now');
      void undo(view);
      expect(view.state.doc.toString()).toBe('Gain <solar/>Firesprite now');
    } finally {
      view.destroy();
    }
  });

  it('no chip before another word, another element, or after Escape or typing', () => {
    catalogue([['Firesprite', 'Solar']]);
    for (const [doc, option] of [
      ['Gain Scorch now', solar],
      ['Gain Firesprite now', arc],
    ] as const) {
      const view = editor(doc, 5);
      insertMarkup(view, option, globals);
      expect(chipState(view.state)).toBeNull();
      view.destroy();
    }
    const view = editor('Gain Firesprite now', 5);
    try {
      insertMarkup(view, solar, globals);
      markChipShown(view, true);
      expect(dismissChip(view)).toBe(true);
      expect(chipState(view.state)).toBeNull();
      insertMarkup(view, solar, globals);
      expect(chipState(view.state)).not.toBeNull();
      view.dispatch({
        changes: { from: view.state.selection.main.head, insert: 'x' },
        selection: { anchor: view.state.selection.main.head + 1 },
        userEvent: 'input.type',
      });
      expect(chipState(view.state)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
