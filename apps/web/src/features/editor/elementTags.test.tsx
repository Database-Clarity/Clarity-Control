// @vitest-environment jsdom
// Element-tagged text authoring (ELEMENT-TAGS-2): the wrap rules, absorption, the markup row's
// "Tag selection:" mode, Ctrl+Space wrap entries, the popover's Unwrap / Remove / Change element,
// symbol view, raw-view highlighting, and undo/redo.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lowerElementTags, type MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { tagRefusals, tagSelection, wrapTransaction } from './elementTags';
import { insertMarkup, markupOptions } from './markupInsertion';
import { findTags, pinTag, toggleRaw } from './symbols';
import { requestItems, suggestContext } from './suggest/source';

const globals: MarkupGlobals = { variables: '', titles: '' };
const solar = markupOptions.find((option) => option.id === 'icon:solar')!;

function state(doc: string, from: number, to = from) {
  return EditorState.create({ doc, selection: EditorSelection.range(from, to) });
}
const select = (doc: string, word: string, occurrence = 0) => {
  let from = -1;
  for (let i = 0; i <= occurrence; i++) from = doc.indexOf(word, from + 1);
  return state(doc, from, from + word.length);
};
const wrapped = (doc: string, word: string, element = 'solar', occurrence = 0) =>
  wrapTransaction(select(doc, word, occurrence), element, globals)?.state.doc.toString() ?? null;

describe('wrap rules', () => {
  it('wraps a plain selection, never trimmed, and keeps every other byte', () => {
    expect(wrapped('Gain Scorch stacks.', 'Scorch')).toBe('Gain <solar Scorch /> stacks.');
    expect(wrapped('Gain Scorch stacks.', ' Scorch')).toBe('Gain<solar  Scorch /> stacks.');
    expect(wrapped('a Void Breach b', 'Void Breach', 'void')).toBe('a <void Void Breach /> b');
  });

  it('lowered, a wrap is the old text with the icon in front of the selection', () => {
    for (const [doc, word] of [
      ['Gain Scorch stacks.', 'Scorch'],
      ['<pve/>Applies Jolt.', 'Jolt'],
      ['< table wide >\n| Amplified | 10%\n<$>', 'Amplified'],
      ['title Info (\nApplies Slow.\n)', 'Slow'],
      ['Base.\nenhanced (\nLonger Radiant.\n)', 'Radiant'],
    ]) {
      const at = doc.indexOf(word);
      expect(lowerElementTags(wrapped(doc, word)!)).toBe(
        `${doc.slice(0, at)}<solar/>${doc.slice(at)}`,
      );
    }
  });

  it('absorbs the same icon right before the selection, and no other', () => {
    expect(wrapped('Gain <solar/>Scorch.', 'Scorch')).toBe('Gain <solar Scorch />.');
    expect(lowerElementTags(wrapped('Gain <solar/>Scorch.', 'Scorch')!)).toBe(
      'Gain <solar/>Scorch.',
    );
    // Another element's icon stays; a spaced pair is not absorbed (the space stays outside).
    expect(wrapped('Gain <arc/>Scorch.', 'Scorch')).toBe('Gain <arc/><solar Scorch />.');
    expect(wrapped('Gain <solar/> Scorch.', 'Scorch')).toBe('Gain <solar/> <solar Scorch />.');
    expect(wrapped('<solar/><solar/>Scorch', 'Scorch')).toBe('<solar/><solar Scorch />');
  });

  it('checks the wrap for the element chosen, not only for Solar (code review F2)', () => {
    // The icon before the selection belongs to an unclosed token: it is not absorbed, and
    // whatever is written lowers to the old line plus the icon, or nothing is written.
    for (const element of ['arc', 'solar']) {
      const doc = '<yellow <arc/>Jolt now';
      const result = wrapped(doc, 'Jolt', element);
      if (result !== null)
        expect(lowerElementTags(result)).toBe(doc.replace('Jolt', `<${element}/>Jolt`));
    }
    // Ctrl+Space offers no wrap that fails for its element.
    const view = select('<yellow <arc/>Jolt now', 'Jolt');
    for (const item of requestItems(suggestContext(view, true)!, view, globals))
      if (item.wrap) {
        const next = view
          .update({
            changes: { from: item.from, to: item.to, insert: item.insert },
          })
          .state.doc.toString();
        expect(lowerElementTags(next)).toBe(
          '<yellow <arc/>' + /^<([a-z]+) /.exec(item.insert)![0].trim() + '/>Jolt now',
        );
      }
  });

  it.each([
    ['nothing selected', state('Gain Scorch', 3), 'none'],
    ['two lines', state('Gain\nScorch', 2, 8), tagRefusals.line],
    ['only spaces', select('Gain   Scorch', '   '), tagRefusals.blank],
    ['crosses a tag', select('Gain <yellow Scorch /> now', 'Scorch /> now'), tagRefusals.tag],
    ['inside a colour tag', select('Gain <yellow Scorch /> now', 'Scorch'), tagRefusals.inside],
    ['inside a title', select('See <title details [Info] />', 'details'), tagRefusals.inside],
    ['inside a tag already', select('Gain <solar Scorch /> now', 'Scorch'), tagRefusals.inside],
    ['an icon in it', select('Gain <solar/>Scorch', '<solar/>Scorch'), tagRefusals.tag],
    ['a table pipe', select('< table wide >\n| a | b\n<$>', 'a | b'), tagRefusals.cell],
    ['a variable', select('var X = 1\nGain #X now', '#X now'), tagRefusals.reference],
    ['a formula', select('Gain ${2*3} now', '${2*3}'), tagRefusals.reference],
    ['a comment', select('Gain /* x */ now', '/* x */'), tagRefusals.reference],
    ['a declaration line', select('var X = Scorch', 'Scorch'), tagRefusals.declaration],
    ['an unclosed < before it', select('a <b Scorch c', 'Scorch'), tagRefusals.tag],
  ])('%s', (_, at, expected) => {
    const result = tagSelection(at, globals);
    expect(result.kind === 'refused' ? result.reason : result.kind).toBe(expected);
  });

  it('several selections are refused', () => {
    const at = EditorState.create({
      doc: 'Scorch and Jolt',
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([
        EditorSelection.range(0, 6),
        EditorSelection.range(11, 15),
      ]),
    });
    expect(tagSelection(at, globals)).toEqual({ kind: 'refused', reason: tagRefusals.ranges });
  });
});

describe('Ctrl+Space with a selection', () => {
  it('the element symbols wrap a wrappable selection; other symbols go in front as before', () => {
    const at = select('Gain <solar/>Scorch.', 'Scorch');
    const context = suggestContext(at, true)!;
    const items = requestItems(context, at, globals);
    const wrap = items.find((item) => item.id === 'icon:solar')!;
    expect(wrap).toMatchObject({
      hint: 'wrap',
      insert: '<solar Scorch />',
      from: 5,
      to: 19,
      wrap: true,
    });
    expect(wrap.preview).toBe('Gain <solar Scorch />.');
    const other = items.find((item) => item.id === 'icon:primary')!;
    expect(other).toMatchObject({ insert: '<primary/>', from: 13, to: 13 });
  });

  it('a selection that cannot be tagged keeps the icon insert', () => {
    const at = select('Gain Scorch\nnow', 'Scorch\nnow');
    const context = suggestContext(at, true)!;
    const item = requestItems(context, at, globals).find((entry) => entry.id === 'icon:solar')!;
    expect(item.insert).toBe('<solar/>');
    expect(item.wrap).toBeUndefined();
  });
});

describe('in the editor', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSettingsStore.getState().updateDevice({ symbolReveal: 'popover' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  /** The editor as a page holds it: every change comes back as the new value. */
  function Host({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <ClarityEditor markupRow value={value} lang="en" globals={globals} onChange={setValue} />
    );
  }
  function mount(value: string) {
    act(() => root.render(<Host initial={value} />));
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    return { view };
  }
  const row = () => host.querySelector('[data-markup-row]')!;
  const label = () => row().querySelector('[data-tag-mode]');
  const button = (id: string) => row().querySelector<HTMLButtonElement>(`[data-entry="${id}"]`)!;
  const key = (view: EditorView, init: KeyboardEventInit) =>
    runScopeHandlers(
      view,
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      'editor',
    );

  it('the row says "Tag selection:" for a wrappable selection, and the element button wraps it', () => {
    const { view } = mount('Gain Scorch stacks.');
    expect(label()).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 5, head: 11 } }));
    expect(label()?.textContent).toBe('Tag selection:');
    expect(button('icon:solar').getAttribute('aria-label')).toBe('Tag selection as Solar');
    expect(button('icon:solar').dataset.wrap).toBe('true');
    expect(button('icon:primary').dataset.wrap).toBeUndefined();
    act(() => button('icon:solar').click());
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> stacks.');
    expect(view.state.selection.main.head).toBe('Gain <solar Scorch />'.length);
    expect(label()).toBeNull();
    // Undo restores the text and the selection; redo tags it again.
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('Gain Scorch stacks.');
    act(() => void redo(view));
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch /> stacks.');
  });

  it('a selection that cannot be tagged shows why; the icon goes in at the caret as before', () => {
    const { view } = mount('Gain <yellow Scorch /> now');
    act(() => view.dispatch({ selection: { anchor: 13, head: 19 } }));
    expect(label()?.textContent).toBe(`Can't tag: ${tagRefusals.inside}`);
    act(() => view.dispatch({ selection: { anchor: 23, head: 26 } }));
    expect(label()?.getAttribute('data-tag-mode')).toBe('wrap');
    act(() => view.dispatch({ selection: { anchor: 0, head: 26 } }));
    expect(label()?.textContent).toBe(`Can't tag: ${tagRefusals.tag}`);
    act(() => button('icon:solar').click());
    expect(view.state.doc.toString()).toBe('Gain <yellow Scorch /> now<solar/>');
    expect(row().querySelector('[role="status"]')?.textContent).toBe(
      `Icon inserted at the caret. Can't tag the selection: ${tagRefusals.tag}.`,
    );
  });

  it('insertMarkup wraps through the All popover path too', () => {
    const { view } = mount('Gain <solar/>Scorch.');
    act(() => view.dispatch({ selection: { anchor: 13, head: 19 } }));
    expect(insertMarkup(view, solar, globals)).toBe('inserted');
    expect(view.state.doc.toString()).toBe('Gain <solar Scorch />.');
  });

  it('symbol view: the icon, then the tinted text; the markup itself is hidden', () => {
    const { view } = mount('Gain <solar Scorch /> stacks.');
    const tint = host.querySelector<HTMLElement>('.cm-tint-el')!;
    expect(tint.classList.contains('cm-el-solar')).toBe(true);
    expect(tint.textContent).toBe('Scorch');
    const icon = host.querySelector<HTMLElement>('.cm-symbol-tag')!;
    expect(icon.dataset.symbol).toBe('solar');
    expect(host.querySelector('.cm-content')!.textContent).toBe('Gain Scorch stacks.');
    // The icon and the first word share one unbreakable run (never split at a line end).
    const glue = icon.closest('.cm-glue')!;
    expect(glue.textContent).toBe('Scorch');
    // Raw view shows the markup with the same tint on the text.
    act(() => view.dispatch({ effects: toggleRaw.of(true) }));
    expect(host.querySelector('.cm-content')!.textContent).toBe('Gain <solar Scorch /> stacks.');
    expect(host.querySelector('.cm-el-solar')?.textContent).toBe('Scorch');
  });

  it('a multi-word tag: the icon and only its first word share one unbreakable run', () => {
    mount('Gain <void Void Breaches /> now and <solar/>Scorch stacks.');
    const [tagIcon, symbolIcon] = host.querySelectorAll<HTMLElement>('.cm-symbol');
    expect(tagIcon.closest('.cm-glue')?.textContent).toBe('Void');
    expect(symbolIcon.closest('.cm-glue')?.textContent).toBe('Scorch');
  });

  it('text the preview draws untinted (a variable in it) keeps the icon and no tint', () => {
    mount('var X = 1\nGain <solar #X Scorch />.');
    expect(host.querySelector('.cm-symbol-tag')).not.toBeNull();
    expect(host.querySelector('.cm-tint-el')).toBeNull();
  });

  it('the popover of pinned tagged text: Unwrap, Remove, and Change element', () => {
    const { view } = mount('Gain <solar Scorch /> now');
    const tag = findTags(view.state.doc.toString())[0]!;
    expect(tag).toMatchObject({ name: 'solar', element: true });
    const pin = () =>
      act(() => {
        const [current] = findTags(view.state.doc.toString());
        view.dispatch({
          selection: { anchor: current!.openTo, head: current!.closeFrom },
          effects: pinTag.of(true),
        });
      });
    const popover = () => host.querySelector<HTMLElement>('.cm-symbol-popover')!;
    const click = (label: string) =>
      act(() =>
        [...popover().querySelectorAll<HTMLButtonElement>('button')]
          .find(
            (element) =>
              element.textContent === label || element.getAttribute('aria-label') === label,
          )!
          .click(),
      );
    pin();
    expect(popover().querySelector('code')?.textContent).toBe('<solar … />');
    expect(popover().querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')).toBe(
      'Solar',
    );
    click('Change to Arc');
    expect(view.state.doc.toString()).toBe('Gain <arc Scorch /> now');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'Scorch',
    );
    click('Unwrap');
    expect(view.state.doc.toString()).toBe('Gain <arc/>Scorch now');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('Gain <arc Scorch /> now');
    pin();
    click('Remove');
    expect(view.state.doc.toString()).toBe('Gain Scorch now');
  });

  it('the popover follows a change to an element of the same length, both ways', () => {
    const { view } = mount('Gain <stasis Scorch /> now');
    act(() => {
      const [tag] = findTags(view.state.doc.toString());
      view.dispatch({
        selection: { anchor: tag!.openTo, head: tag!.closeFrom },
        effects: pinTag.of(true),
      });
    });
    const popover = () => host.querySelector<HTMLElement>('.cm-symbol-popover')!;
    const button = (label: string) =>
      [...popover().querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => element.textContent === label || element.getAttribute('aria-label') === label,
      )!;
    const pressed = () =>
      popover().querySelector('[aria-pressed="true"]')?.getAttribute('aria-label');
    act(() => button('Change to Strand').click());
    expect(view.state.doc.toString()).toBe('Gain <strand Scorch /> now');
    expect(pressed()).toBe('Strand');
    expect(popover().querySelector('code')?.textContent).toBe('<strand … />');
    act(() => button('Change to Stasis').click());
    expect(view.state.doc.toString()).toBe('Gain <stasis Scorch /> now');
    expect(pressed()).toBe('Stasis');
    act(() => button('Change to Strand').click());
    act(() => button('Unwrap').click());
    expect(view.state.doc.toString()).toBe('Gain <strand/>Scorch now');
  });

  it('keys on pinned tagged text: Alt+Backspace unwraps, Backspace removes', () => {
    const { view } = mount('Gain <void Volatile /> now');
    const pin = () =>
      act(() => {
        const [current] = findTags(view.state.doc.toString());
        view.dispatch({
          selection: { anchor: current!.openTo, head: current!.closeFrom },
          effects: pinTag.of(true),
        });
      });
    pin();
    act(() => void key(view, { key: 'Backspace', altKey: true }));
    expect(view.state.doc.toString()).toBe('Gain <void/>Volatile now');
    act(() => void undo(view));
    pin();
    act(() => void key(view, { key: 'Backspace' }));
    expect(view.state.doc.toString()).toBe('Gain Volatile now');
  });

  it('a click on the icon of tagged text pins the tag', () => {
    const { view } = mount('Gain <strand Sever /> now');
    const icon = host.querySelector<HTMLElement>('.cm-symbol-tag')!;
    act(() => {
      icon.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe('Sever');
    expect(host.querySelector('.cm-symbol-popover')).not.toBeNull();
  });
});
