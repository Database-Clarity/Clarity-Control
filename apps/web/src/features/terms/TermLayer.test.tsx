// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TermLayer, TermPopover, type SpanSource } from './TermLayer';
import { useSettingsStore } from '../../stores/settings';

// jsdom has no CSS Custom Highlights, caret hit-testing, or range geometry: minimal stand-ins.
class FakeHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}
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
  // One mark drawn in the overlay (a box per line), none of it inside the rendered content.
  expect(host.querySelector('[data-term-marks]')?.getAttribute('data-term-marks')).toBe('1');
  expect(host.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(1);
  expect(host.querySelector('p')!.innerHTML).toBe('Lasts <span data-slot="0">5</span> seconds.');
  expect(CSS.highlights.size).toBe(0);
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

it('keeps the English in the accessible label and puts each Insert beside its name', () => {
  const anchor = document.createRange();
  anchor.selectNodeContents(host);
  act(() =>
    root.render(
      <TermPopover
        term={{ en: 'Chaos Reshaped', kind: 'name', official: ['Chaos remanié'] }}
        anchor={anchor}
        lang="fr"
        canInsert
        onInsert={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  const dialog = document.querySelector('[data-term-popover]')!;
  expect(dialog.getAttribute('aria-label')).toBe('Chaos Reshaped: in game');
  expect(dialog.firstElementChild?.textContent).toBe('In game · French');
  expect(dialog.textContent).not.toContain('Chaos Reshaped');
  expect(dialog.querySelector('strong')?.parentElement?.querySelector('button')?.textContent).toBe(
    'Insert',
  );
  // Signed out: no empty footer or footer action.
  expect(dialog.lastElementChild?.querySelector('strong')).not.toBeNull();
});

it('keeps the default popover DOM identical when optional number metadata is absent', async () => {
  const anchor = document.createRange();
  anchor.selectNodeContents(host);
  const term = { en: 'Voltshot', kind: 'name' as const, official: ['Voltschuss'] };
  const props = { anchor, lang: 'de' as const, canInsert: true, onInsert() {}, onClose() {} };
  await act(async () => root.render(<TermPopover {...props} term={term} />));
  const original = document.querySelector('[data-term-popover]')!.outerHTML;
  await act(async () =>
    root.render(<TermPopover {...props} term={{ ...term, number: undefined }} />),
  );
  expect(document.querySelector('[data-term-popover]')!.outerHTML).toBe(original);
});

it('routes a number through its insertion command and opens its popover on touch', async () => {
  const insert = vi.fn(() => true);
  const spans: SpanSource = (element) => {
    const span = element.querySelector('[data-slot]')!;
    const range = document.createRange();
    range.selectNodeContents(span);
    return [
      {
        range,
        term: {
          en: '5',
          kind: 'number',
          official: ['5'],
          insertOnClick: true,
          number: { kind: 'Number', context: 'lasts _ seconds', scope: 'PvP', insert },
        },
      },
    ];
  };
  await act(async () =>
    root.render(
      <TermLayer lang="de" hash={7} enabled={false} canInsert spanSource={spans}>
        <span data-slot="1">5</span>
      </TermLayer>,
    ),
  );
  const span = host.querySelector('[data-slot]')!;
  (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
    offsetNode: span.firstChild,
    offset: 0,
  });
  const down = (touch: boolean) => {
    const event = new Event('pointerdown', { bubbles: true });
    Object.assign(event, { clientX: 5, clientY: 5, pointerType: touch ? 'touch' : 'mouse' });
    span.dispatchEvent(event);
  };
  await act(async () => {
    down(false);
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }),
    );
  });
  expect(insert).toHaveBeenCalledTimes(1);
  await act(async () => {
    down(true);
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }),
    );
  });
  expect(insert).toHaveBeenCalledTimes(1);
  const dialog = document.querySelector('[data-term-popover]')!;
  expect(dialog.textContent).toContain('Number');
  expect(dialog.textContent).toContain('PvP');
  await act(async () => (dialog.querySelector('button') as HTMLButtonElement).click());
  expect(insert).toHaveBeenCalledTimes(2);
});

it('keeps the in-game prefix separate from the name and attributes an agreed term in one footer', () => {
  const anchor = document.createRange();
  anchor.selectNodeContents(host);
  act(() =>
    root.render(
      <TermPopover
        term={{
          en: 'Chaos Reshaped',
          kind: 'glossary',
          official: ['Chaos remanié'],
          inGame: ['Chaos remodelé'],
          glossary: {
            en: 'Chaos Reshaped',
            term: 'Chaos remanié',
            note: 'Use the agreed spelling.',
            updatedBy: 'alice',
            updatedAt: '2026-11-14T00:00:00Z',
          },
        }}
        anchor={anchor}
        lang="fr"
        canInsert={false}
        onInsert={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  const dialog = document.querySelector('[data-term-popover]')!;
  expect(dialog.firstElementChild?.textContent).toBe('Agreed term · French');
  expect(dialog.querySelectorAll('strong')[1]?.querySelector('span')?.textContent).toBe('In game:');
  expect(dialog.querySelector('p')?.textContent).toBe('Use the agreed spelling.');
  expect(dialog.lastElementChild?.querySelector('small')?.textContent).toContain('alice ·');
  expect(dialog.querySelector('button')).toBeNull();
});

it('shows an absolute attribution date and time using the app format and zone', () => {
  const previous = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...previous, dateFormat: 'dmy', timeDisplay: 'relative', timeZone: 'UTC' },
  });
  const anchor = document.createRange();
  anchor.selectNodeContents(host);
  try {
    act(() =>
      root.render(
        <TermPopover
          term={{
            en: 'Chaos Reshaped',
            kind: 'glossary',
            official: ['Chaos refaçonné'],
            glossary: {
              en: 'Chaos Reshaped',
              term: 'Chaos refaçonné',
              updatedBy: 'alice',
              updatedAt: '2026-11-14T00:00:00Z',
            },
          }}
          anchor={anchor}
          lang="fr"
          canInsert={false}
          onInsert={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    const dialog = document.querySelector('[data-term-popover]')!;
    expect(dialog.querySelector('[role="tooltip"]')?.textContent).toBe('14 Nov 2026, 00:00 UTC');
    expect(dialog.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-14T00:00:00Z');
    expect(dialog.querySelector('[title]')).toBeNull();
  } finally {
    act(() => useSettingsStore.setState({ settings: previous }));
  }
});
