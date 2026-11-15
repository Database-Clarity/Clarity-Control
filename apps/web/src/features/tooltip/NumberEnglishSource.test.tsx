// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
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
} from '../editor/numbers/state';
import { registerNumbers } from '../editor/numbers/documents';

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

it('marks only source-owned numbers, lists hidden values, and updates sets without rebuilding ranges', async () => {
  const text = 'var d = 4.5\nDamage ${2*3} lasts 5 seconds.\nValue #d.';
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
  const range = [...CSS.highlights.get('number-todo')!][0];
  await act(async () => {
    insertNumber(editor, 2);
  });
  expect(CSS.highlights.get('number-used')?.size).toBe(1);
  expect(CSS.highlights.get('number-used')?.has(range)).toBe(true);
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
