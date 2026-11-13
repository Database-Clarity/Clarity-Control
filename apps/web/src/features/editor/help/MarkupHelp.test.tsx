// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { findRetiredMarkup, parseMarkup, type MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { markupEntries } from '../markupRow/entries';
import { moveSuggest, openSuggest, suggestState } from '../suggest/state';
import {
  editorKeys,
  helpBlocks,
  helpEnhancedGlobals,
  helpGlobals,
  helpIdAt,
  helpIdForSuggestion,
  helpRows,
  keyOf,
  retiredAnswer,
} from './reference';
import './MarkupHelp';

const globals: MarkupGlobals & { allowBaseEnhanced: boolean } = {
  allowBaseEnhanced: true,
  variables: 'var e = 🡅',
  titles: '',
};
const adagio =
  'Weapon Kills grant the following for #e${7+#d} seconds:\n• 10 Range\n\nenhanced (\nvar d = 1\n#e Buff duration is increased by 1 second.\n)';

describe('the help reads one registry', () => {
  const rows = helpRows();
  const ids = new Set(rows.map((row) => row.id));

  it('gives every static markup entry a row, and every row entry resolves', () => {
    const entries = markupEntries(globals).filter((entry) => !entry.id.startsWith('var:'));
    for (const entry of entries) {
      expect(entry.help, entry.id).toBeDefined();
      expect(ids.has(entry.id), entry.id).toBe(true);
    }
    for (const row of rows.filter((row) => row.entry))
      expect(entries.some((entry) => entry.id === row.entry!.id)).toBe(true);
    // Row names and explanations are the entry's own.
    const yellow = rows.find((row) => row.id === 'inline:yellow')!;
    const entry = entries.find((item) => item.id === 'inline:yellow')!;
    expect([yellow.label, yellow.about]).toEqual([entry.label, entry.about]);
  });

  it('draws every example without an error and without retired markup', () => {
    const texts = [
      ...rows.filter((row) => row.example && !row.plain).map((row) => row.example!),
      ...Object.values(helpBlocks).map((block) => block.lines.map((line) => line.text).join('\n')),
    ];
    for (const text of texts) {
      for (const lookup of [helpGlobals, helpEnhancedGlobals]) {
        const parsed = parseMarkup(text, lookup);
        expect(
          parsed.diagnostics.filter((d) => d.severity === 'error'),
          text,
        ).toEqual([]);
      }
      expect(findRetiredMarkup(text), text).toEqual([]);
    }
    for (const row of rows.filter((row) => row.example && !row.plain && !row.note)) {
      const lines = parseMarkup(row.example!, helpGlobals).lines;
      expect(
        lines.some((line) => line.linesContent?.length),
        row.id,
      ).toBe(true);
    }
  });

  it('lists no retired or removed behaviour, and short key labels', () => {
    for (const row of rows)
      expect(`${row.label} ${row.about} ${row.keys ?? ''}`).not.toMatch(
        /Scroll Lock|align|indent|Ctrl\+Z/i,
      );
    expect(ids.has('style:center')).toBe(false);
    for (const name of ['blue', 'green', 'purple', 'center', 'background', 'breakSpaces'])
      expect(rows.some((row) => row.example?.includes(`<${name}`))).toBe(false);
    for (const key of editorKeys) expect(key.keys.length).toBeLessThanOrEqual(19);
    expect(keyOf('key-leave')).toBe('Esc then Tab');
  });

  it('answers a retired name with retired.ts wording and the replacement row', () => {
    const blue = retiredAnswer('blue')!;
    expect(blue.message).toContain('<blue … />');
    expect(blue.instead).toBe('inline:yellow');
    expect(retiredAnswer('bl')).toBeNull();
    expect(retiredAnswer('table')?.message).toContain('table');
  });

  it('finds the construct under the caret', () => {
    const at = (doc: string, line: number, column: number) => {
      const state = EditorState.create({ doc });
      return helpIdAt(state, state.doc.line(line).from + column);
    };
    expect(at(adagio, 1, 40)).toBe('enhanced-formula');
    expect(at(adagio, 1, 3)).toBeNull();
    expect(at(adagio, 2, 1)).toBe('list-dot');
    expect(at(adagio, 3, 0)).toBe('blank');
    expect(at(adagio, 6, 1)).toBe('enhanced-arrow');
    expect(at(adagio, 6, 20)).toBe('enhanced-block');
    expect(at('A <pve 1 /> <pvp [2] /> b', 1, 14)).toBe('pair');
    expect(at('Lasts 1 <pvp [2] /> s', 1, 10)).toBe('pvp-override');
    expect(at('<bold/>Only', 1, 2)).toBe('line:bold');
    expect(at('<yellow Gjallarhorn />', 1, 3)).toBe('inline:yellow');
    expect(at('Applies <arc/>Jolt', 1, 10)).toBe('icon-word');
    expect(at('Uses <arc/> here', 1, 7)).toBe('icon:arc');
    expect(at('title Jolt (\nChains.\n)', 2, 2)).toBe('decl-title');
    expect(at('Uses #Zoom', 1, 6)).toBe('decl-var');
    expect(at('x // note <bold y />', 1, 15)).toBe('comment');
    expect(at('Get ${10 * 2}%', 1, 6)).toBe('math');
    // Comments as production reads them: a URL's `//` is not one, and `/* */` spans lines.
    expect(at('See <link wiki [https://example.com] /> here', 1, 24)).toBe('link');
    expect(at('/* first\nsecond\n*/\nText', 2, 3)).toBe('comment');
    expect(at('// whole line', 1, 4)).toBe('comment');
    expect(at('/* first\nsecond\n*/\nText', 4, 2)).toBeNull();
  });

  it('maps menu options to their rows', () => {
    expect(helpIdForSuggestion('tag:yellow')).toBe('inline:yellow');
    expect(helpIdForSuggestion('snippet:enhanced-block')).toBe('enhanced-block');
    expect(helpIdForSuggestion('icon:solar')).toBe('icon:solar');
    expect(helpIdForSuggestion('style:bold')).toBe('line:bold');
    expect(helpIdForSuggestion('var:damage')).toBe('decl-var');
    expect(helpIdForSuggestion('transform:wrap')).toBeNull();
  });
});

describe('the sheet in the editor', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

  const mount = async (doc: string, readOnly = false, allowBaseEnhanced = true) => {
    await act(async () =>
      root.render(
        <ClarityEditor
          value={doc}
          lang="en"
          onChange={() => undefined}
          globals={{ ...globals, allowBaseEnhanced }}
          readOnly={readOnly}
          markupRow
        />,
      ),
    );
    return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  };
  const sheet = () => document.querySelector<HTMLElement>('[data-markup-help]');
  const active = () =>
    sheet()?.querySelector('[aria-selected="true"]')?.getAttribute('data-help-row');
  const press = async (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    await act(async () => {
      target.dispatchEvent(event);
    });
    // Opened before the idle build, the sheet builds a few groups a frame: wait until it is whole.
    for (let frame = 0; frame < 20 && sheet()?.hasAttribute('data-building'); frame++)
      await act(() => new Promise((done) => setTimeout(done, 20)));
    return event;
  };

  it.each([true, false])('documents base/enhanced but scopes Insert to eligible categories (%s)', async (allowed) => {
    const view = await mount('{{10%}{15%}}', false, allowed);
    act(() => { view.focus(); view.dispatch({ selection: { anchor: 3 } }); });
    await press(host.querySelector('.cm-content')!, 'F1');
    expect(active()).toBe('base-enhanced-pair');
    expect([...sheet()!.querySelectorAll('button')].some((button) => button.textContent?.startsWith('Insert'))).toBe(allowed);
    if (!allowed) {
      await press(document.activeElement!, 'Enter');
      expect(view.state.doc.toString()).toBe('{{10%}{15%}}');
    }
  });

  it('F1 opens on the markup under the caret, F1 closes, and Esc gives focus back', async () => {
    const view = await mount(adagio);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 40 } });
    });
    const content = host.querySelector('.cm-content')!;
    const event = await press(content, 'F1');
    expect(event.defaultPrevented).toBe(true);
    expect(sheet()).not.toBeNull();
    expect(active()).toBe('enhanced-formula');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter markup and keys');
    await press(document.activeElement!, 'Escape');
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(content);
    expect(view.state.selection.main.head).toBe(40);
    await press(content, 'F1');
    expect(sheet()).not.toBeNull();
    await press(document.activeElement!, 'F1');
    expect(sheet()).toBeNull();
  });

  it('F1 over the Ctrl+Space menu closes it and opens on the highlighted option', async () => {
    const view = await mount('Deals ');
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 6 } });
      openSuggest(view);
    });
    const snapshot = suggestState(view.state)!;
    const target = snapshot.items.findIndex((item) => item.id === 'tag:yellow');
    expect(target).toBeGreaterThanOrEqual(0);
    act(() => moveSuggest(view, target, true));
    await press(host.querySelector('.cm-content')!, 'F1');
    expect(suggestState(view.state)).toBeNull();
    expect(active()).toBe('inline:yellow');
  });

  it('Enter inserts what the markup row inserts, as one step, and returns to the text', async () => {
    const view = await mount('Deals ');
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 6 } });
    });
    await press(host.querySelector('.cm-content')!, 'F1');
    const field = document.activeElement as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, 'yellow');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(active()).toBe('inline:yellow');
    await press(field, 'Enter');
    expect(sheet()).toBeNull();
    const viaHelp = view.state.doc.toString();
    // The same entry run straight from the registry on the same text.
    const other = new EditorView({
      state: EditorState.create({ doc: 'Deals ', selection: { anchor: 6 } }),
      parent: document.body,
    });
    markupEntries(globals)
      .find((entry) => entry.id === 'inline:yellow')!
      .run(other, globals);
    expect(viaHelp).toBe(other.state.doc.toString());
    other.destroy();
  });

  it('a retired name answers in the status and dims nothing it replaces', async () => {
    const view = await mount('Deals ');
    act(() => view.focus());
    await press(host.querySelector('.cm-content')!, 'F1');
    const field = document.activeElement as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, 'blue');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sheet()!.querySelector('[data-status]')?.textContent).toContain('<blue … />');
    expect(active()).toBe('inline:yellow');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, 'zzz');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sheet()!.querySelector('[data-status]')?.textContent).toBe(
      'No markup or key matches “zzz”.',
    );
  });

  it('read-only: the same sheet without Insert', async () => {
    const view = await mount('Deals', true);
    act(() => view.focus());
    await press(host.querySelector('.cm-content')!, 'F1');
    expect(sheet()).not.toBeNull();
    expect(
      [...sheet()!.querySelectorAll('button')].some((b) => /Insert/.test(b.textContent ?? '')),
    ).toBe(false);
    await press(document.activeElement!, 'Enter');
    expect(view.state.doc.toString()).toBe('Deals');
  });

  it('builds the sheet hidden once the editor is quiet (a key restarts the wait); F1 reveals it', async () => {
    vi.stubGlobal('requestIdleCallback', (run: IdleRequestCallback) =>
      window.setTimeout(() => run({ didTimeout: false, timeRemaining: () => 50 }), 0),
    );
    vi.stubGlobal('cancelIdleCallback', (id: number) => window.clearTimeout(id));
    const wait = (ms: number) => act(() => new Promise((done) => setTimeout(done, ms)));
    const kept = () => document.querySelector<HTMLElement>('section[aria-label="Markup help"]');
    const view = await mount(adagio);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 40 } });
    });
    const content = host.querySelector('.cm-content')!;
    await wait(1000);
    await press(content, 'ArrowRight');
    await wait(1000);
    // 2 s after mounting but only 1 s after the key: not built yet.
    expect(kept()).toBeNull();
    for (let i = 0; i < 40 && !kept(); i++) await wait(50);
    const parked = kept()!;
    expect(parked).not.toBeNull();
    expect(parked.hasAttribute('inert')).toBe(true);
    expect(parked.getAttribute('aria-hidden')).toBe('true');
    expect(
      document.querySelector('#editor-panel-help, [data-editor-overlay], [data-markup-help]'),
    ).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 40 } }));
    await press(content, 'F1');
    expect(sheet()).toBe(parked);
    expect(parked.id).toBe('editor-panel-help');
    expect(parked.hasAttribute('inert')).toBe(false);
    expect(active()).toBe('enhanced-formula');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter markup and keys');
    await press(document.activeElement!, 'Escape');
    expect(kept()).toBe(parked);
    expect(parked.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(content);
  });

  it('a sheet open across the phone width follows it: tap-outside closes only on a phone', async () => {
    let phone = false;
    const listeners = new Set<(event: { type: string; matches: boolean }) => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === '(max-width: 700px)' && phone;
      },
      media: query,
      addEventListener: (_: string, run: (event: { type: string; matches: boolean }) => void) =>
        listeners.add(run),
      removeEventListener: (_: string, run: (event: { type: string; matches: boolean }) => void) =>
        listeners.delete(run),
    }));
    const view = await mount(adagio);
    act(() => view.focus());
    const content = host.querySelector('.cm-content')!;
    await press(content, 'F1');
    const tap = async (target: Element) =>
      act(async () => {
        target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      });
    // A desktop: a press in the text leaves it open.
    await tap(content);
    expect(sheet()).not.toBeNull();
    await act(async () => {
      phone = true;
      listeners.forEach((run) => run({ type: 'change', matches: phone }));
    });
    expect(sheet()).not.toBeNull();
    await tap(content);
    expect(sheet()).toBeNull();
    // Back to a desktop while open: a press in the text leaves it open again.
    await press(content, 'F1');
    await act(async () => {
      phone = false;
      listeners.forEach((run) => run({ type: 'change', matches: phone }));
    });
    await tap(content);
    expect(sheet()).not.toBeNull();
  });

  it('the issues panel closed by its last fix stays closed when an issue returns', async () => {
    await mount('Uses #missing');
    const item = () => host.querySelector<HTMLElement>('[data-status-issues]');
    await act(async () => item()!.click());
    expect(document.querySelector('#editor-panel-issues')).not.toBeNull();
    await mount('Valid text');
    expect(document.querySelector('#editor-panel-issues')).toBeNull();
    await mount('Uses #missing');
    expect(item()).not.toBeNull();
    expect(document.querySelector('#editor-panel-issues')).toBeNull();
  });

  it('a bare Tab and the removed table-align keys change nothing', async () => {
    const view = await mount('< table x >\n| a | b |\n<$>');
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 3 } });
    });
    const content = host.querySelector('.cm-content')!;
    const before = view.state.doc.toString();
    const tab = await press(content, 'Tab');
    // Handled (so the browser does not move focus), and the text is untouched.
    expect(tab.defaultPrevented).toBe(true);
    await press(content, 'ScrollLock');
    await press(content, 'F', { ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe(before);
  });
});
