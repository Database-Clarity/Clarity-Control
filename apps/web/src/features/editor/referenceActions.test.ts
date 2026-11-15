// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { referenceExtensions, type TooltipTarget } from './referenceActions';
import { sourcesFromGlobals } from './references';

const globals = { variables: 'var damage = 25\nvar other = 1', titles: '' };
const views: EditorView[] = [];

function editor(doc: string, anchor: number, navigate?: (target: TooltipTarget) => void) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: referenceExtensions({
        lang: 'en',
        globals,
        sources: () => sourcesFromGlobals(globals, 'en'),
        selfHash: () => 99,
        navigate: () => navigate,
      }),
    }),
  });
  views.push(view);
  return view;
}

function press(view: EditorView, init: KeyboardEventInit) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { ...init, bubbles: true }), 'editor');
}

afterEach(() => views.splice(0).forEach((view) => view.destroy()));

describe('F12 go to definition', () => {
  test('a global variable navigates to its tooltip line, leaving the text alone', () => {
    const navigate = vi.fn();
    const doc = 'Deal #damage';
    const view = editor(doc, doc.length - 2, navigate);
    expect(press(view, { key: 'F12', code: 'F12' })).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ type: 'tooltip', hash: 2, lang: 'en', line: 1 });
    expect(view.state.doc.toString()).toBe(doc);
  });
  test('a local var moves the selection onto the definition and changes no text', () => {
    const doc = 'var mine = 5\n\n\n#mine';
    const view = editor(doc, doc.length);
    expect(press(view, { key: 'F12', code: 'F12' })).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'mine',
    );
    expect(view.state.selection.main.from).toBe(4);
  });
  test('an undefined reference does not navigate and is not an edit', () => {
    const navigate = vi.fn();
    const doc = '#nothing';
    const view = editor(doc, 3, navigate);
    expect(press(view, { key: 'F12', code: 'F12' })).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(doc);
  });
  test('without a navigation host a cross-tooltip target is not opened', () => {
    const view = editor('#damage', 3);
    expect(press(view, { key: 'F12', code: 'F12' })).toBe(true);
    expect(view.state.selection.main.head).toBe(3);
  });
  test('F12 away from any reference falls through', () => {
    const view = editor('plain text', 2);
    expect(press(view, { key: 'F12', code: 'F12' })).toBe(false);
  });
});

describe('Ctrl+K Ctrl+I popover', () => {
  const chord = (view: EditorView) => {
    press(view, { key: 'k', code: 'KeyK', ctrlKey: true });
    press(view, { key: 'i', code: 'KeyI', ctrlKey: true });
  };
  test('pins the preview for the reference at the caret, with its reason when undefined', () => {
    const found = editor('#damage', 3);
    chord(found);
    expect(found.dom.querySelector('.clarity-reference-popover')?.textContent).toContain('25');
    const missing = editor('#nothing', 3);
    chord(missing);
    expect(missing.dom.querySelector('.clarity-reference-popover')?.textContent).toContain(
      'Not defined',
    );
  });
  test('shows nothing away from a reference, and Escape closes the popover', () => {
    const plain = editor('plain', 2);
    chord(plain);
    expect(plain.dom.querySelector('.clarity-reference-popover')).toBeNull();
    const found = editor('#damage', 3);
    chord(found);
    expect(press(found, { key: 'Escape', code: 'Escape' })).toBe(true);
    expect(found.dom.querySelector('.clarity-reference-popover')).toBeNull();
  });
});

describe('Ctrl link hints', () => {
  const hint = (view: EditorView) => view.dom.querySelector('.clarity-reference-link')?.textContent;
  const key = (type: string, ctrlKey: boolean) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Control', ctrlKey, metaKey: ctrlKey }));
  test('measures the pointer only when the held state or pointer changes', () => {
    const doc = 'var mine = 5\n#mine';
    const view = editor(doc, 0);
    const at = vi.spyOn(view, 'posAtCoords').mockReturnValue(doc.length - 2);
    view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
    expect(at).not.toHaveBeenCalled();
    key('keydown', true);
    expect(at).toHaveBeenCalledTimes(1);
    expect(hint(view)).toBe('#mine');
    // Held Ctrl shortcuts and key repeat do not measure again.
    for (let i = 0; i < 5; i++) key('keydown', true);
    expect(at).toHaveBeenCalledTimes(1);
    view.dom.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 6, clientY: 5, ctrlKey: true, metaKey: true }),
    );
    expect(at).toHaveBeenCalledTimes(2);
    key('keyup', false);
    expect(hint(view)).toBeUndefined();
    key('keyup', false);
    expect(at).toHaveBeenCalledTimes(2);
  });
  test('an edit while held clears the hint and the next pointer move restores it', () => {
    const doc = 'var mine = 5\n#mine';
    const view = editor(doc, 0);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(doc.length - 2);
    view.dom.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 5, clientY: 5, ctrlKey: true, metaKey: true }),
    );
    expect(hint(view)).toBe('#mine');
    view.dispatch({ changes: { from: 11, to: 12, insert: '6' } });
    expect(hint(view)).toBeUndefined();
    view.dom.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 5, clientY: 5, ctrlKey: true, metaKey: true }),
    );
    expect(hint(view)).toBe('#mine');
  });
});
