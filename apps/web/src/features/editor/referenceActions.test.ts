// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { referenceExtensions, type TooltipTarget } from './referenceActions';
import { sourcesFromGlobals } from './references';
import { openUrl, urlInLine } from './urls';

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

describe('Ctrl+Click web addresses', () => {
  const click = (view: EditorView, pos: number, ctrlKey: boolean) => {
    vi.spyOn(view, 'posAtCoords').mockReturnValue(pos);
    // CodeMirror's own mouse selection (when the click is not handled) measures too.
    vi.spyOn(view, 'posAndSideAtCoords').mockReturnValue({ pos, assoc: 1 });
    const event = new MouseEvent('mousedown', {
      button: 0,
      clientX: 5,
      clientY: 5,
      ctrlKey,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    return event;
  };
  const opened = () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    return open;
  };
  afterEach(() => vi.restoreAllMocks());

  test('a bare URL opens in a new tab with no opener, leaving the text and caret alone', () => {
    const open = opened();
    const doc = 'See https://d2clarity.com/a?b=1 now';
    const view = editor(doc, 0);
    const event = click(view, 10, true);
    expect(open).toHaveBeenCalledWith(
      'https://d2clarity.com/a?b=1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(0);
  });
  test('the URL inside link markup opens without its brackets', () => {
    const open = opened();
    const doc = '<link Clarity [https://d2clarity.com] />';
    const view = editor(doc, 0);
    click(view, doc.indexOf('d2'), true);
    expect(open).toHaveBeenCalledWith('https://d2clarity.com/', '_blank', 'noopener,noreferrer');
  });
  test('trailing punctuation is not part of the URL', () => {
    const open = opened();
    const view = editor('Read https://x.y/a. Then (see https://x.y/b), fine', 0);
    click(view, 8, true);
    expect(open).toHaveBeenLastCalledWith('https://x.y/a', '_blank', 'noopener,noreferrer');
    click(view, 32, true);
    expect(open).toHaveBeenLastCalledWith('https://x.y/b', '_blank', 'noopener,noreferrer');
    expect(urlInLine('https://en.wiki/A_(b)', 3)?.url).toBe('https://en.wiki/A_(b)');
  });
  test('square brackets inside a URL stay; the link markup closer does not', () => {
    expect(urlInLine('see https://x.y/?ids[]=1 now', 8)?.url).toBe('https://x.y/?ids[]=1');
    expect(urlInLine('https://[::1]/a', 3)?.url).toBe('https://[::1]/a');
    expect(urlInLine('<link A [https://x.y/a[1]] />', 12)?.url).toBe('https://x.y/a[1]');
    expect(urlInLine('<link A [https://x.y/?q=1] />', 12)?.url).toBe('https://x.y/?q=1');
  });
  test('other schemes never open', () => {
    const open = opened();
    for (const doc of ['javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.c', 'ftp://x.y/']) {
      const view = editor(doc, 0);
      click(view, 5, true);
    }
    expect(urlInLine('xhttps://x.y', 3)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openUrl('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  test('a plain click places the caret as usual', () => {
    const open = opened();
    const view = editor('See https://x.y/a', 0);
    click(view, 8, false);
    expect(open).not.toHaveBeenCalled();
    // CodeMirror's own mouse selection ran (jsdom has no layout, so not the exact offset).
    expect(view.state.selection.main.head).not.toBe(0);
  });
  test('a URL wins over a reference inside it, and only inside its range', () => {
    const open = opened();
    const navigate = vi.fn();
    const doc = 'https://x.y/#damage #damage';
    const view = editor(doc, 0, navigate);
    click(view, 15, true);
    expect(open).toHaveBeenCalledWith('https://x.y/#damage', '_blank', 'noopener,noreferrer');
    expect(navigate).not.toHaveBeenCalled();
    click(view, doc.length - 2, true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
  test('Ctrl over a URL shows the link hint', () => {
    const view = editor('See https://x.y/a.', 0);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(8);
    view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, ctrlKey: true }));
    expect(view.dom.querySelector('.clarity-reference-link')?.textContent).toBe('https://x.y/a');
  });
});
