// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState, Transaction } from '@codemirror/state';
import { history as undoHistory, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NumberEnglishSource, numberAfter } from './NumberEnglishSource';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { numberSource } from '../editor/numbers/model';
import {
  createNumberStore,
  insertNumber,
  numberExtension,
  numberHost,
  pointNumber,
} from '../editor/numbers/state';
import { registerNumbers } from '../editor/numbers/documents';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import { ReadingCompare } from '../preview/ReadingCompare';

const history = vi.hoisted(() => ({ before: '', available: true }));
vi.mock('../../services/history', () => ({
  getHistory: async () => ({ commits: history.available ? [{ commit: 'a'.repeat(40) }] : [] }),
  getVersion: async () => ({
    tooltip: {
      hash: 7,
      associated: [],
      text: {
        en: { text: history.before, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' },
      },
    },
  }),
}));

let root: ReturnType<typeof createRoot>,
  host: HTMLDivElement,
  editor: EditorView,
  unregister: () => void;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { highlights: new Map() });
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  unregister?.();
  editor?.destroy();
  host.remove();
  vi.unstubAllGlobals();
});

it('updates only changed span states, keeps elements stable, and leaves transient highlights alone', async () => {
  CSS.highlights.set('clarity-term-open', new Highlight());
  const text = 'var d = 4.5\nDamage ${2*3} lasts 5 seconds.\nValue #d.';
  const source = numberSource(text, undefined, 'de'),
    store = createNumberStore();
  editor = new EditorView({
    parent: document.body,
    state: EditorState.create({
      extensions: [
        undoHistory(),
        numberHost.of({ source, lang: 'de', changed: store.changed }),
        numberExtension(),
      ],
    }),
  });
  editor.dom.dataset.tooltipHash = '7';
  unregister = registerNumbers(7, 'de', store);
  await act(async () =>
    root.render(
      <NumberEnglishSource
        hash={7}
        lang="de"
        text={text}
        enabled={false}
        canInsert
        stepping={false}
      >
        {() => <ReadingTooltip text={text} hash={7} />}
      </NumberEnglishSource>,
    ),
  );
  expect(host.querySelector('[data-slot="2"]')?.textContent).toBe('6');
  expect(host.querySelector('[data-slot="3"]')?.textContent).toBe('5');
  expect(host.textContent).toContain('Not shown in the text: d = 4.5');
  const derived = [...host.querySelectorAll('span')].find(
    (span) => span.textContent === 'Value 4.5.',
  );
  expect(derived?.querySelector('[data-slot]')).toBeNull();
  const formula = host.querySelector<HTMLElement>('[data-slot="2"]')!;
  expect(formula.dataset.numberState).toBe('todo');
  await act(async () => {
    insertNumber(editor, 2);
  });
  expect(formula.dataset.numberState).toBe('used');
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  observer.observe(host, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-number-state'],
  });
  await act(async () => pointNumber(editor, 2));
  expect(formula.dataset.numberState).toBe('next');
  expect(changes.map((record) => (record.target as HTMLElement).dataset.slot).sort()).toEqual([
    '2',
    '3',
  ]);
  await act(async () => pointNumber(editor));
  expect(formula.dataset.numberState).toBe('used');
  changes.length = 0;
  await act(async () => {
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'x' } });
    editor.dispatch({
      changes: { from: editor.state.doc.length - 1, to: editor.state.doc.length },
    });
  });
  expect(changes).toEqual([]);
  expect(host.querySelector('[data-slot="2"]')).toBe(formula);
  const last = host.querySelector<HTMLElement>('[data-slot="3"]')!;
  act(() => editor.dispatch({ selection: { anchor: 0 } }));
  expect(host.querySelector<HTMLElement>('[data-slot="1"]')?.dataset.numberState).toBe('next');
  act(() =>
    editor.dispatch({
      changes: { from: 0, insert: '#{=3}' },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of('input.paste'),
    }),
  );
  expect(last.dataset.numberState).toBe('used');
  act(() => undo(editor));
  expect(editor.state.doc.toString()).toBe('#{=2}');
  expect(last.dataset.numberState).not.toBe('used');
  observer.disconnect();
  await act(async () => root.render(null));
  expect(formula.hasAttribute('data-number-state')).toBe(false);
  expect(CSS.highlights.size).toBe(1);
  expect(CSS.highlights.has('clarity-term-open')).toBe(true);
});

it('decorates exact raw after-side slices, including numbers split across diff runs', async () => {
  const source = numberSource('Damage 12.5 for 5 seconds.', undefined, 'de');
  await act(async () =>
    root.render(
      <p>
        {numberAfter(source, 'Damage 12.', 0)}
        {numberAfter(source, '5 for 5 seconds.', 10)}
      </p>,
    ),
  );
  expect(host.textContent).toBe(source.text);
  expect(
    [...host.querySelectorAll('[data-slot="1"]')].map((span) => span.textContent).join(''),
  ).toBe('12.5');
  expect(host.querySelector('[data-slot="2"]')?.textContent).toBe('5');
});

it('keeps visible owned Compare values inline and never marks another document’s override value', async () => {
  const text = 'Damage 5.',
    source = numberSource(text, undefined, 'de'),
    store = createNumberStore();
  editor = new EditorView({
    parent: document.body,
    state: EditorState.create({
      extensions: [
        numberHost.of({ source, lang: 'de', changed: store.changed }),
        numberExtension(),
      ],
    }),
  });
  editor.dom.dataset.tooltipHash = '7';
  unregister = registerNumbers(7, 'de', store);
  await act(async () =>
    root.render(
      <NumberEnglishSource
        hash={7}
        lang="de"
        text={text}
        enabled={false}
        canInsert
        stepping={false}
      >
        {() => (
          <ReadingCompare baseText={text} baseHash={7} enhancedText="Damage 10." enhancedHash={8} />
        )}
      </NumberEnglishSource>,
    ),
  );
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  const span = host.querySelector('[data-english-compare] [data-slot="1"]')!;
  expect(span?.textContent).toBe('5');
  expect(host.textContent).not.toContain('Not shown in the text');
  expect([...host.querySelectorAll('[data-slot]')].some((span) => span.textContent === '10')).toBe(
    false,
  );
  Range.prototype.getClientRects = () =>
    [{ left: 0, right: 20, top: 0, bottom: 20, width: 20, height: 20 }] as unknown as DOMRectList;
  (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
    offsetNode: span.firstChild,
    offset: 0,
  });
  await act(async () =>
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })),
  );
  expect(editor.state.doc.toString()).toBe('#{=1}');
});

it.each([
  ['markup only', 'Gain <solar/>Scorch 5.', 'Gain <solar Scorch /> 5.', true],
  ['word diff', 'Damage 4.', 'Damage 5.', true],
  ['raw fallback', '', 'Damage 5.', false],
] as const)(
  'marks and inserts the after-side identity in %s',
  async (_state, before, text, available) => {
    history.before = before;
    history.available = available;
    const source = numberSource(text, undefined, 'de'),
      store = createNumberStore();
    editor = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          numberHost.of({ source, lang: 'de', changed: store.changed }),
          numberExtension(),
        ],
      }),
    });
    editor.dom.dataset.tooltipHash = '7';
    unregister = registerNumbers(7, 'de', store);
    await act(async () =>
      root.render(
        <NumberEnglishSource
          hash={7}
          lang="de"
          text={text}
          enabled={false}
          canInsert
          stepping={false}
          changes
        >
          {(renderAfter) => (
            <EnglishDiffContent
              hash={7}
              sourceUpdatedAt="2026-01-01T00:00:00Z"
              current={text}
              renderAfter={renderAfter}
            />
          )}
        </NumberEnglishSource>,
      ),
    );
    await act(async () => {});
    const span = host.querySelector('[data-slot="1"]')!;
    expect(span?.textContent).toBe('5');
    expect(span.closest('del,s')).toBeNull();
    Range.prototype.getClientRects = () =>
      [{ left: 0, right: 20, top: 0, bottom: 20, width: 20, height: 20 }] as unknown as DOMRectList;
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
      offsetNode: span.firstChild,
      offset: 0,
    });
    await act(async () =>
      span.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })),
    );
    expect(editor.state.doc.toString()).toBe('#{=1}');
  },
);
