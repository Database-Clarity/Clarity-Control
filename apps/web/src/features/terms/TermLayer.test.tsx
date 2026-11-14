// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TermLayer, type SpanSource } from './TermLayer';

// jsdom has no CSS Custom Highlights, caret hit-testing, or range geometry: minimal stand-ins.
class FakeHighlight extends Set<Range> {}
const box = { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20, x: 0, y: 0 };
let host: HTMLDivElement;
let root: Root;
let editor: EditorView;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Highlight', FakeHighlight);
  vi.stubGlobal('CSS', { highlights: new Map<string, FakeHighlight>() });
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0),
  );
  Range.prototype.getClientRects = function () {
    return [box] as unknown as DOMRectList;
  };
  host = document.createElement('div');
  document.body.append(host);
  editor = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'Hält  s.' }),
  });
  editor.dom.dataset.tooltipHash = '7';
  editor.dispatch({ selection: { anchor: 5 } });
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  vi.unstubAllGlobals();
});

it('marks spans from a span source and inserts on click for a single exact insert', async () => {
  // A number-token source: every [data-slot] span is a mark whose click inserts its token.
  const slots: SpanSource = (element) =>
    [...element.querySelectorAll<HTMLElement>('[data-slot]')].map((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      return {
        term: {
          en: span.textContent!,
          kind: 'name',
          official: [`{${span.dataset.slot}}`],
          insertOnClick: true,
        },
        range,
      };
    });
  await act(async () =>
    root.render(
      <TermLayer lang="de" hash={7} enabled={false} canInsert spanSource={slots}>
        <p>
          Lasts <span data-slot="0">5</span> seconds.
        </p>
      </TermLayer>,
    ),
  );
  const marks = CSS.highlights.get('clarity-term') as unknown as FakeHighlight;
  expect([...marks].map((range) => range.toString())).toEqual(['5']);
  const slot = host.querySelector('[data-slot]')!;
  (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
    offsetNode: slot.firstChild,
    offset: 0,
  });
  await act(async () => {
    host
      .querySelector('p')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
  });
  expect(editor.state.doc.toString()).toBe('Hält {0} s.');
  // No popover for a single exact insert.
  expect(document.querySelector('[data-term-popover]')).toBeNull();
});
