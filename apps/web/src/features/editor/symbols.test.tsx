// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { findSymbols, findTags, symbolExtensions } from './symbols';

const globals: MarkupGlobals = { variables: '', titles: '' };
const doc = 'Deal <arc/> damage <yellow 5 <solar/> /> and <pve 3 /> done.\n<void/>';

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

function mount(value = doc, extra: Partial<Parameters<typeof ClarityEditor>[0]> = {}) {
  const changes: string[] = [];
  act(() =>
    root.render(
      <ClarityEditor
        value={value}
        lang="en"
        globals={globals}
        onChange={(text) => changes.push(text)}
        {...extra}
      />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  return { view, changes };
}
const key = (view: EditorView, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  return runScopeHandlers(view, event, 'editor');
};
const symbols = () => [...host.querySelectorAll<HTMLElement>('.cm-symbol')];
const tints = () => [...host.querySelectorAll<HTMLElement>('.cm-tint')];
const content = () => host.querySelector('.cm-content')!.textContent!;

describe('findSymbols / findTags', () => {
  it('finds icon tags only; unknown and non-colour tags stay raw', () => {
    const found = findSymbols(doc).map((s) => [s.kind, s.name, doc.slice(s.from, s.to)]);
    expect(found).toEqual([
      ['icon', 'arc', '<arc/>'],
      ['icon', 'solar', '<solar/>'],
      ['icon', 'void', '<void/>'],
    ]);
    expect(findSymbols('<unknown/> <notatag >')).toEqual([]);
  });

  it('pairs colour tags per line (outer before inner) with the markup ranges', () => {
    const found = findTags(doc).map((t) => [
      t.name,
      doc.slice(t.from, t.openTo),
      doc.slice(t.openTo, t.closeFrom),
      doc.slice(t.closeFrom, t.to),
    ]);
    expect(found).toEqual([
      ['yellow', '<yellow ', '5 <solar/>', ' />'],
      ['pve', '<pve ', '3', ' />'],
    ]);
  });

  it('nests: the inner tag is listed after the outer and encloses a sub-range', () => {
    const text = '<yellow a <blue b /> c /> d';
    const [outer, inner] = findTags(text);
    expect([outer.name, inner.name]).toEqual(['yellow', 'blue']);
    expect(text.slice(outer.openTo, outer.closeFrom)).toBe('a <blue b /> c');
    expect(text.slice(inner.openTo, inner.closeFrom)).toBe('b');
  });

  it('leaves unpaired tags, stray closings, other tags and empty tags raw', () => {
    expect(findTags('a /> b <link x /> <center y />')).toEqual([]);
    expect(findTags('<yellow lone')).toEqual([]);
    expect(findTags('<yellow one\ntwo />')).toEqual([]);
    expect(findTags('<pve /> <pvp  />')).toEqual([]);
    // A non-colour tag inside does not steal the closing of the colour tag.
    expect(findTags('<yellow a <link b /> c />').map((t) => t.name)).toEqual(['yellow']);
  });
});

describe('incremental symbol rendering', () => {
  const create = (
    text: string,
    mode: 'popover' | 'caret',
    selection: { anchor: number; head?: number } = { anchor: 0 },
  ) =>
    EditorState.create({
      doc: text,
      selection,
      extensions: symbolExtensions({ mode: () => mode, raw: () => false }),
    });
  const renderedRanges = (state: EditorState) => {
    const ranges: { from: number; to: number; tint?: string; icon?: string }[] = [];
    for (const decorations of state.facet(EditorView.decorations)) {
      if (typeof decorations === 'function') continue;
      decorations.between(0, state.doc.length, (from, to, value) => {
        ranges.push({ from, to, tint: value.spec.class, icon: value.spec.widget?.name });
      });
    }
    return ranges.sort(
      (a, b) =>
        a.from - b.from || a.to - b.to || JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  };
  it('keeps document offsets when a custom line separator is configured', () => {
    let state = EditorState.create({
      doc: 'first\r\n<arc/> <yellow second />\r\n<void/>',
      extensions: [
        EditorState.lineSeparator.of('\r\n'),
        ...symbolExtensions({ mode: () => 'popover', raw: () => false }),
      ],
    });
    expect(renderedRanges(state)).toEqual(renderedRanges(create(state.doc.toString(), 'popover')));
    state = state.update({ changes: { from: 0, insert: 'new' } }).state;
    expect(renderedRanges(state)).toEqual(renderedRanges(create(state.doc.toString(), 'popover')));
  });
  it.each(['popover', 'caret'] as const)(
    'keeps fresh-render parity through edits, line joins and caret moves in %s mode',
    (mode) => {
      let state = create(`${doc}\n<blue nested <bold text /> tail />\nlast <pvp end />`, mode);
      const compare = () => {
        const current = state.selection.main;
        const fresh = create(state.doc.toString(), mode, {
          anchor: current.anchor,
          head: current.head,
        });
        expect(renderedRanges(state)).toEqual(renderedRanges(fresh));
      };
      compare();
      // Replacing newline boundaries must rebuild both sides, while ordinary
      // typing and selections leave all unrelated line decorations intact.
      const edits = [
        { from: 2, insert: 'plain' },
        { from: 14, insert: '\n' },
        { from: 14, to: 15, insert: '' },
        { from: 0, to: 6, insert: '<void/>' },
        { from: 11, to: 28, insert: '<green joined />\n' },
      ];
      for (const changes of edits) {
        state = state.update({ changes, selection: { anchor: changes.from } }).state;
        compare();
        state = state.update({ selection: { anchor: state.doc.length } }).state;
        compare();
      }
      state = state.update({
        changes: [
          { from: 0, insert: '<arc/>' },
          { from: state.doc.length, insert: '\n<solar/>' },
        ],
      }).state;
      compare();
      state = state.update({ changes: { from: 0, to: state.doc.length, insert: '' } }).state;
      compare();
    },
  );
  it.each(['popover', 'caret'] as const)(
    'preserves decorations across varied malformed-markup edits in %s mode',
    (mode) => {
      let seed = 0x7814ab;
      const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 0x100000000;
      };
      let state = create(Array.from({ length: 40 }, () => doc).join('\n'), mode);
      const inserts = ['', 'word', '\n', '<arc/>', ' />', '<yellow ', '<blue x />'];
      for (let i = 0; i < 150; i++) {
        const from = Math.floor(random() * (state.doc.length + 1));
        const to = Math.min(state.doc.length, from + Math.floor(random() * 18));
        const insert = inserts[Math.floor(random() * inserts.length)];
        const anchor = Math.floor(random() * (state.doc.length - to + from + insert.length + 1));
        state = state.update({ changes: { from, to, insert }, selection: { anchor } }).state;
        expect(renderedRanges(state)).toEqual(
          renderedRanges(create(state.doc.toString(), mode, { anchor })),
        );
      }
    },
  );
});

describe('symbol view', () => {
  it('draws icons as fixed-width symbols and tints the text of colour tags, never changing the document', () => {
    const { view, changes } = mount();
    expect(view.state.doc.toString()).toBe(doc);
    expect(changes).toEqual([]);
    expect(symbols().map((s) => s.dataset.symbol)).toEqual(['arc', 'solar', 'void']);
    expect(tints().map((t) => [t.className, t.textContent])).toEqual([
      ['cm-tint cm-tint-yellow', '5 '],
      ['cm-tint cm-tint-pve', '3'],
    ]);
    // The markup is hidden; the text is not.
    expect(content()).not.toMatch(/<arc\/>|<yellow|<pve| \/>/);
    expect(content()).toContain('Deal');
    expect(content()).toContain('and');
    // Copying selects the raw text.
    expect(view.state.sliceDoc(0, view.state.doc.length)).toBe(doc);
  });

  it('tints nested tags with the inner one winning, and leaves an unpaired tag raw', () => {
    mount('<yellow a <blue b /> c /> <green lone');
    // One span per tag; the blue one sits inside the yellow one, so the inner tint wins.
    expect(tints().map((t) => [t.className, t.textContent])).toEqual([
      ['cm-tint cm-tint-yellow', 'a b c'],
      ['cm-tint cm-tint-blue', 'b'],
    ]);
    expect(host.querySelector('.cm-tint-yellow .cm-tint-blue')).not.toBeNull();
    expect(content()).toContain('<green lone');
    expect(content()).not.toContain('<yellow');
  });

  it('marks bold as bold (no colour of its own)', () => {
    mount('<bold strong /> and <pve 3 />');
    expect(tints().map((t) => t.className)).toEqual([
      'cm-tint cm-tint-bold',
      'cm-tint cm-tint-pve',
    ]);
  });

  it('hides the markup atomically: the caret steps over a hidden opening tag', () => {
    const { view } = mount('<yellow ab />');
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    act(() => {
      key(view, { key: 'ArrowRight' });
    });
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual('<yellow '.length);
  });

  it('are atomic: Backspace removes the whole tag and only that', () => {
    const { view } = mount();
    const end = doc.indexOf('<arc/>') + '<arc/>'.length;
    act(() => view.dispatch({ selection: { anchor: end } }));
    act(() => {
      key(view, { key: 'Backspace' });
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<arc/>', ''));
  });

  it('raw toggle (Ctrl+Shift+.) shows the markup, drops the tints and survives a document switch', () => {
    const { view } = mount();
    act(() => {
      key(view, { key: '.', code: 'Period', ctrlKey: true, shiftKey: true });
    });
    expect(symbols()).toHaveLength(0);
    expect(tints()).toHaveLength(0);
    expect(content()).toContain('<arc/>');
    expect(content()).toContain('<yellow 5');
    expect(view.state.doc.toString()).toBe(doc);
    act(() =>
      root.render(
        <ClarityEditor value="<arc/> x" lang="en" globals={globals} onChange={() => {}} />,
      ),
    );
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(0);
    act(() => {
      key(view, { key: '.', code: 'Period', ctrlKey: true, shiftKey: true });
    });
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(1);
  });

  it('popover mode: a selected symbol shows its markup, Enter edits it, Esc cancels', () => {
    const { view } = mount();
    const from = doc.indexOf('<arc/>');
    act(() => view.dispatch({ selection: { anchor: from, head: from + 6 } }));
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<arc/>');
    act(() => {
      key(view, { key: 'Enter' });
    });
    const input = host.querySelector<HTMLInputElement>('.cm-symbol-input')!;
    expect(input.value).toBe('<arc/>');
    input.value = '<void/>';
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<arc/>', '<void/>'));
    expect(host.querySelector('.cm-symbol-input')).toBeNull();
  });

  it('hover shows the popover without touching the document', () => {
    const { view } = mount();
    const widget = symbols()[0];
    act(() => {
      widget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc);
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<arc/>');
    act(() => {
      widget.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(host.querySelector('.cm-symbol-popover')).toBeNull();
  });

  it('hover on tinted text shows the tag in a popover without touching the document', () => {
    const { view } = mount();
    const tint = tints()[1];
    vi.spyOn(view, 'posAtCoords').mockReturnValue(doc.indexOf('3'));
    act(() => {
      tint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc);
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<pve … />');
    act(() => {
      tint.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(host.querySelector('.cm-symbol-popover')).toBeNull();
  });

  it('a selected tag edits its colour with Enter and loses its markup (keeping the text) with Backspace', () => {
    const { view } = mount();
    const inner = doc.indexOf('3');
    act(() => view.dispatch({ selection: { anchor: inner, head: inner + 1 } }));
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<pve … />');
    expect(host.querySelector('.cm-symbol-hint')?.textContent).toContain('remove tag');
    act(() => {
      key(view, { key: 'Enter' });
    });
    const input = host.querySelector<HTMLInputElement>('.cm-symbol-input')!;
    expect(input.value).toBe('<pve');
    input.value = '<blue';
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<pve 3 />', '<blue 3 />'));
    expect(tints().map((t) => t.className)).toContain('cm-tint cm-tint-blue');
    // The text stays selected, so Backspace now removes the tag around it.
    act(() => {
      key(view, { key: 'Backspace' });
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<pve 3 />', '3'));
  });

  it('a selection of the whole tag also removes just the markup, keeping the text', () => {
    const { view } = mount('x <yellow ab /> y');
    act(() => view.dispatch({ selection: { anchor: 2, head: 15 } }));
    act(() => {
      key(view, { key: 'Backspace' });
    });
    expect(view.state.doc.toString()).toBe('x ab y');
  });

  it('Alt+click on tinted text selects the tag text and shows its popover', () => {
    const { view } = mount('x <yellow ab /> y');
    vi.spyOn(view, 'posAtCoords').mockReturnValue(11);
    act(() => {
      tints()[0].dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true, button: 0 }),
      );
    });
    expect(view.state.selection.main).toMatchObject({ from: 10, to: 12 });
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<yellow … />');
  });

  it('caret mode shows the raw markup only where the caret is', () => {
    act(() => useSettingsStore.getState().updateDevice({ symbolReveal: 'caret' }));
    const { view } = mount();
    act(() => view.dispatch({ selection: { anchor: doc.indexOf('<arc/>') + 2 } }));
    expect(host.querySelector('.cm-content')!.textContent).toContain('<arc/>');
    expect(host.querySelector('.cm-content')!.textContent).not.toContain('<solar/>');
    expect(host.querySelector('.cm-symbol-popover')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
    // A caret inside a colour tag shows its markup (the text stays tinted); the other tag stays hidden.
    act(() => view.dispatch({ selection: { anchor: doc.indexOf('5 ') + 1 } }));
    expect(content()).toContain('<yellow 5');
    expect(content()).not.toContain('<pve');
    expect(tints().map((t) => t.className)).toContain('cm-tint cm-tint-yellow');
  });

  it('are absent when the editor shows stored forms', () => {
    mount(doc, { symbols: false, readOnly: true });
    expect(symbols()).toHaveLength(0);
    expect(tints()).toHaveLength(0);
    expect(content()).toContain('<yellow 5');
  });
});
