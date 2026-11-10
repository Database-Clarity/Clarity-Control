// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { keepParagraphInView, paragraphAt } from '../scrollMargins';
import { leadEntries, markupEntries, rowEntries, rowSeparator, type MarkupEntry } from './entries';
import { useKeyboardFollow, followKeyboard, useKeyboardInset } from '../../../ui/useKeyboardInset';

const globals: MarkupGlobals = { variables: 'var damage = 25', titles: '' };

/** Glacial Guard's saved English text (live data). */
const glacialGuard = [
  'Requires a <stasis/>Stasis Super Ability to be equipped. Overwrites Barricade Cooldown to a unique, faster, 70 second Base Cooldown class ability (~30 seconds at 100 Class Stat).',
  '',
  'Scoring 2 <stasis/>Stasis Kills within 3 seconds of each grants a Stack of <stasis/>Frost Armor.',
  '',
  'Restores 10 HP for each Stack of <stasis/>Frost Armor you gain from any source.',
  '',
  "Replaces Barricade with Glacial Guard which has a cooldown matching Towering Barricade's. Does not work with <arc/>Thruster.",
  '',
  'On Glacial Guard Cast:',
  '• Grants you maximum <stasis/>Frost Armor Stacks (restoring HP for each Stack gained)',
  '• Applies <pve 100 /> <pvp [40] /> <stasis/>Slow to enemies within ? meters',
].join('\n');

const ids = (items: readonly (MarkupEntry | typeof rowSeparator)[]) =>
  items.map((item) => (item === rowSeparator ? '|' : item.id));

describe('leadEntries', () => {
  const row = rowEntries(markupEntries(globals));

  it("leads with the entries Glacial Guard's English text uses, by first use", () => {
    const led = ids(leadEntries(row, glacialGuard));
    expect(led.slice(0, 7)).toEqual([
      'icon:stasis',
      'icon:arc',
      'bullet',
      'pair',
      'pve',
      'pvp',
      '|',
    ]);
    // The rest keeps the row's order, without doubled or trailing separators, and loses nothing.
    expect(led.filter((id) => id !== '|').sort()).toEqual(
      ids(row)
        .filter((id) => id !== '|')
        .sort(),
    );
    expect(led.join(',')).not.toMatch(/\|,\|/);
    expect(led.at(-1)).not.toBe('|');
  });

  it('keeps the row order without a source (English) or when the source uses nothing', () => {
    expect(leadEntries(row, undefined)).toBe(row);
    expect(leadEntries(row, '')).toBe(row);
    expect(leadEntries(row, 'Plain words only.')).toBe(row);
  });
});

describe('paragraphAt', () => {
  const state = EditorState.create({ doc: 'one\ntwo\n\nthree\nfour\nfive\n\nsix' });
  it('spans the lines between blank lines around the caret', () => {
    expect(paragraphAt(state, state.doc.line(5).from + 1)).toEqual({
      from: state.doc.line(4).from,
      to: state.doc.line(6).to,
    });
    expect(paragraphAt(state, 0)).toEqual({ from: 0, to: state.doc.line(2).to });
    // A blank line is a paragraph of its own.
    const blank = state.doc.line(3);
    expect(paragraphAt(state, blank.from)).toEqual({ from: blank.from, to: blank.to });
  });
});

let host: HTMLDivElement;
let root: Root;
let phone = true;
let frames: FrameRequestCallback[] = [];
const flushFrames = () =>
  act(() => {
    const now = frames;
    frames = [];
    for (const frame of now) frame(0);
  });

class FakeViewport extends EventTarget {
  height = 772;
  width = 390;
  offsetTop = 0;
}
let viewport: FakeViewport;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && /max-width: 700px|pointer: coarse/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  viewport = new FakeViewport();
  vi.stubGlobal('visualViewport', viewport);
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 40,
    right: 41,
    top: 100,
    bottom: 116,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 390,
    top: 0,
    bottom: 600,
    width: 390,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  phone = true;
  frames = [];
  document.documentElement.style.removeProperty('--kb-inset');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(props: Partial<Parameters<typeof ClarityEditor>[0]> = {}) {
  act(() =>
    root.render(
      <ClarityEditor
        value={'• first <pve 10 />\nsecond'}
        lang="en"
        globals={globals}
        markupRow
        onChange={() => {}}
        {...props}
      />,
    ),
  );
  return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
}
const bar = () => host.querySelector<HTMLElement>('[data-markup-row]');
/** The status bar's own buttons: everything outside the markup row. */
const statusButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => !button.closest('[data-markup-row]') && button.textContent?.trim() === label,
  );

describe('the docked keyboard bar', () => {
  it('docks on a phone with Suggest beside All; Raw moves to the status bar', () => {
    mount();
    expect(bar()?.hasAttribute('data-docked')).toBe(true);
    expect(host.querySelector('[data-editor-root]')?.hasAttribute('data-docked')).toBe(true);
    expect(bar()?.querySelector('[data-suggest-button]')).not.toBeNull();
    expect(bar()?.querySelector('[data-raw-toggle]')).toBeNull();
    expect(statusButton('Suggest')).toBeUndefined();
    expect(statusButton('Raw')).toBeDefined();
  });

  it('is the plain top row on a wider screen (Raw in the row, Suggest in the status bar)', () => {
    phone = false;
    mount();
    expect(bar()?.hasAttribute('data-docked')).toBe(false);
    expect(bar()?.querySelector('[data-suggest-button]')).toBeNull();
    expect(bar()?.querySelector('[data-raw-toggle]')).not.toBeNull();
    expect(statusButton('Suggest')).toBeDefined();
  });

  it('shows no bar while read-only or closed; closed, Raw and Suggest return to the status bar', () => {
    mount({ readOnly: true });
    expect(bar()).toBeNull();
    expect(statusButton('Suggest')).toBeUndefined();
    mount({ markupRow: false });
    expect(bar()).toBeNull();
    expect(host.querySelector('[data-editor-root]')?.hasAttribute('data-docked')).toBe(false);
    expect(statusButton('Suggest')).toBeDefined();
    expect(statusButton('Raw')).toBeDefined();
  });

  it('opens All as a bottom sheet when docked, not hanging from the trigger', () => {
    mount();
    const all = bar()!.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;
    act(() => all.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const sheet = document.body.querySelector('[role=dialog][aria-label="All markup"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.hasAttribute('data-sheet-top')).toBe(false);
    act(() => all.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  });

  it('shows the bar on an empty text', () => {
    mount({ value: '' });
    expect(bar()?.hasAttribute('data-docked')).toBe(true);
  });

  it('leads with the English text only while translating, and only docked', () => {
    mount({ lang: 'de', sourceText: glacialGuard });
    const first = () => bar()!.querySelector<HTMLElement>('[data-row-button]')!.dataset.entry;
    expect(first()).toBe('icon:stasis');
    mount({ lang: 'en', sourceText: glacialGuard });
    expect(first()).toBe('bullet');
    phone = false;
    act(() => root.unmount());
    root = createRoot(host);
    mount({ lang: 'de', sourceText: glacialGuard });
    expect(first()).toBe('bullet');
  });

  it('keeps focus in the text on a bar tap and inserts at the selection', () => {
    const view = mount({ value: 'abc' });
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 3 } });
    });
    const button = bar()!.querySelector<HTMLButtonElement>('[data-entry="bullet"]')!;
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => button.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(view.state.doc.toString()).toBe('• abc');
    expect(document.activeElement).toBe(view.contentDOM);
    const suggest = bar()!.querySelector<HTMLButtonElement>('[data-suggest-button]')!;
    const suggestPress = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => suggest.dispatchEvent(suggestPress));
    expect(suggestPress.defaultPrevented).toBe(true);
  });
});

describe('useKeyboardInset', () => {
  it('writes --kb-inset once per frame, without rendering again', () => {
    let renders = 0;
    function Probe() {
      renders++;
      useKeyboardInset(true);
      return null;
    }
    vi.stubGlobal('innerHeight', 772);
    act(() => root.render(<Probe />));
    flushFrames();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--kb-inset')).toBe('0px');
    const before = renders;
    // iOS: the keyboard shrinks the visual viewport only.
    viewport.height = 472;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(style.getPropertyValue('--kb-inset')).toBe('300px');
    expect(style.getPropertyValue('--kb-room')).toBe('300px');
    // Panning the visual viewport moves the bar with it; the room below the text stays.
    viewport.offsetTop = 100;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    flushFrames();
    expect(style.getPropertyValue('--kb-inset')).toBe('200px');
    expect(style.getPropertyValue('--kb-room')).toBe('300px');
    expect(renders).toBe(before);
    act(() => root.render(null));
    expect(style.getPropertyValue('--kb-inset')).toBe('');
  });
});

describe('keyboard follow', () => {
  it('runs the focused element’s follower once when the visible area shrinks, never on growth', () => {
    function Shell() {
      useKeyboardFollow();
      return null;
    }
    act(() => root.render(<Shell />));
    const field = document.createElement('div');
    field.tabIndex = 0;
    document.body.append(field);
    field.focus();
    const follow = vi.fn();
    const stop = followKeyboard(field, follow);
    viewport.height = 400;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('resize'));
    });
    flushFrames();
    expect(follow).toHaveBeenCalledTimes(1);
    viewport.height = 772;
    act(() => viewport.dispatchEvent(new Event('resize')));
    flushFrames();
    expect(follow).toHaveBeenCalledTimes(1);
    stop();
    field.remove();
  });

  it('keeps a paragraph that fits whole in view, else the caret with context', () => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: 'a\nb\nc\n\nd', selection: { anchor: 2 } }),
    });
    const dispatch = vi.spyOn(view, 'dispatch');
    vi.spyOn(view, 'lineBlockAt').mockImplementation(
      (pos) =>
        ({
          top: view.state.doc.lineAt(pos).number * 20 - 20,
          bottom: view.state.doc.lineAt(pos).number * 20,
        }) as never,
    );
    keepParagraphInView(view, { top: 0, bottom: 400 });
    const fits = dispatch.mock.calls[0]![0] as {
      effects: { value: { range: { from: number; to: number } } };
    };
    expect(fits.effects.value.range).toMatchObject({ from: 0, to: 5 });
    keepParagraphInView(view, { top: 0, bottom: 40 });
    const tall = dispatch.mock.calls[1]![0] as {
      effects: { value: { range: { from: number; to: number }; yMargin: number } };
    };
    expect(tall.effects.value.range).toMatchObject({ from: 2, to: 2 });
    expect(tall.effects.value.yMargin).toBeGreaterThan(0);
    view.destroy();
  });
});
