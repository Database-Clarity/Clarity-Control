// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countConflicts, writeConflictMarkers } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { conflictsOf } from './conflicts';

let host: HTMLDivElement;
let root: Root;
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const buttons = (scope: ParentNode) =>
  [...scope.querySelectorAll('button')].map((b) => b.textContent);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const first = writeConflictMarkers(['mine 1'], ['theirs 1'], '(bob, 2026-11-03 18:02)');
const second = writeConflictMarkers(['mine 2a', 'mine 2b'], ['theirs 2']);
const text = `top\n${first}\nmiddle\n${second}\nbottom`;
let latest = text;

function Harness({
  initial = text,
  readOnly = false,
  source,
}: {
  initial?: string;
  readOnly?: boolean;
  source?: Parameters<typeof ClarityEditor>[0]['conflictSource'];
}) {
  const [value, setValue] = useState(initial);
  return (
    <ClarityEditor
      value={value}
      lang="en"
      globals={{ variables: '', titles: '' }}
      readOnly={readOnly}
      conflictSource={source}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}
const mount = (props: Parameters<typeof Harness>[0] = {}) => {
  latest = props.initial ?? text;
  act(() => root.render(<Harness {...props} />));
};
const view = () => EditorView.findFromDOM(q('.cm-editor')!)!;

describe('inline conflicts in the editor', () => {
  it('colours the blocks and offers the full actions only on the active one', () => {
    mount();
    expect(all('.cm-conflict-mine').length).toBe(3); // mine 1, mine 2a, mine 2b
    expect(all('.cm-conflict-theirs').length).toBe(2);
    expect(all('.cm-conflict-marker').length).toBe(6);
    const widgets = all('.cm-conflict-actions');
    expect(widgets).toHaveLength(2);
    // The actions are inside the first marker line of their block, at its end.
    for (const widget of widgets) expect(widget.closest('.cm-conflict-open')).not.toBeNull();
    expect(buttons(widgets[0]!)).toEqual([
      'Accept mine',
      'Accept theirs',
      'Accept both',
      'Compare',
    ]);
    expect(buttons(widgets[1]!)).toEqual(['Compare']);
    expect(q('[data-status-conflicts]')?.textContent).toBe('2 conflicts');
  });

  it('resolves a block with an undoable edit and moves the actions on', () => {
    mount();
    act(() => all('.cm-conflict-actions')[0]!.querySelectorAll('button')[1]!.click());
    expect(latest).toBe(`top\ntheirs 1\nmiddle\n${second}\nbottom`);
    expect(all('.cm-conflict-actions')).toHaveLength(1);
    expect(buttons(all('.cm-conflict-actions')[0]!)).toContain('Accept both');
    act(() => all('.cm-conflict-actions')[0]!.querySelectorAll('button')[2]!.click());
    expect(latest).toBe('top\ntheirs 1\nmiddle\nmine 2a\nmine 2b\ntheirs 2\nbottom');
    expect(countConflicts(latest)).toBe(0);
    expect(q('[data-status-conflicts]')).toBeNull();
  });

  it('treats a hand edit that removes the markers as resolving it', () => {
    mount();
    const doc = view().state.doc.toString();
    const from = doc.indexOf('<<<<<<< mine');
    const to = doc.indexOf('mine 1');
    act(() => view().dispatch({ changes: { from, to, insert: '' } }));
    const rest = view().state.doc.toString();
    const sep = rest.indexOf('=======');
    const end = rest.indexOf('\nmiddle');
    act(() => view().dispatch({ changes: { from: sep, to: end, insert: '' } }));
    expect(countConflicts(latest)).toBe(1);
    expect(all('.cm-conflict-actions')).toHaveLength(1);
    expect(latest).toContain('top\nmine 1\n\nmiddle');
  });

  it('walks the blocks with F8 and Shift+F8, wrapping round', () => {
    mount();
    const press = (key: string, shiftKey = false) =>
      act(() => {
        q('.cm-content')!.dispatchEvent(
          new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
        );
      });
    const at = () => conflictsOf(view().state).active;
    const head = () => view().state.selection.main.head;
    const doc = view().state.doc.toString();
    press('F8');
    expect(head()).toBe(doc.indexOf('<<<<<<< mine'));
    expect(at()).toBe(0);
    press('F8');
    expect(head()).toBe(doc.lastIndexOf('<<<<<<< mine'));
    expect(at()).toBe(1);
    press('F8');
    expect(at()).toBe(0);
    press('F8', true);
    expect(at()).toBe(1);
    // The actions follow: the second block now has the full set.
    expect(buttons(all('.cm-conflict-actions')[1]!)).toContain('Accept mine');
    expect(buttons(all('.cm-conflict-actions')[0]!)).toEqual(['Compare']);
  });

  it('changes no line text or count: the widget is not part of the document', () => {
    mount();
    expect(view().state.doc.toString()).toBe(text);
    expect(view().state.doc.lines).toBe(text.split('\n').length);
    // One decorated line per document line of a block, and no extra lines for the widgets.
    expect(all('.cm-line').length).toBe(text.split('\n').length);
  });

  it('raises no markup issue for the markers', () => {
    mount();
    expect(q('[data-editor-status]')?.textContent).not.toMatch(/issue/);
  });

  it('read-only editors can compare but not resolve', () => {
    mount({ readOnly: true });
    for (const widget of all('.cm-conflict-actions')) expect(buttons(widget)).toEqual(['Compare']);
  });

  it('Compare shows mine, base and theirs and Esc returns', () => {
    mount({
      source: {
        mine: 'M',
        base: 'B',
        theirs: 'T',
        theirsLabel: '(bob, 2026-11-03 18:02)',
      },
    });
    act(() => all('.cm-conflict-actions')[0]!.querySelectorAll('button')[3]!.click());
    const compare = q('[data-conflict-compare]')!;
    expect(compare).not.toBeNull();
    expect(compare.textContent).toContain('Mine');
    expect(compare.textContent).toContain('Base');
    expect(compare.textContent).toContain('Theirs (bob, 2026-11-03 18:02)');
    expect(view().state.doc.toString()).toBe(text);
    act(() => {
      compare.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('[data-conflict-compare]')).toBeNull();
  });

  it('Compare without the source falls back to the block itself', () => {
    mount();
    act(() => all('.cm-conflict-actions')[1]!.querySelectorAll('button')[0]!.click());
    const compare = q('[data-conflict-compare]')!;
    expect(compare.textContent).toContain('mine 2a');
    expect(compare.textContent).toContain('theirs 2');
    expect(compare.textContent).toContain('Not available any more');
  });
});
