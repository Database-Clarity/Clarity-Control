// @vitest-environment jsdom
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { undo } from '@codemirror/commands';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { pinTag, toggleRawView } from './symbols';

const globals: MarkupGlobals = { variables: '', titles: '' };
// The two retired tags of tooltip 2799418574 (Rites of Ember), with a current yellow beside them.
const rites =
  "Daybreak.\n\n<blue Solar Fulmination /> from the <blue Hunter's Journal Artifact /> doubles <yellow it />.";
const clean = 'Daybreak.\n\n<yellow it /> and <bold this />.';

let host: HTMLDivElement;
let root: Root;
let latest = '';

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

/** The editor as the page holds it: the text is state, and tooltips are stepped by swapping it. */
function Harness({ first, second }: { first: string; second?: string }) {
  const [step, setStep] = useState(0);
  const [text, setText] = useState(first);
  return (
    <>
      <button
        data-step
        onClick={() => {
          setStep(1);
          setText(second ?? '');
        }}
      >
        next
      </button>
      <ClarityEditor
        key={step}
        value={text}
        lang="en"
        globals={globals}
        tooltipHash={step + 10}
        onChange={(next) => {
          latest = next;
          setText(next);
        }}
      />
    </>
  );
}

const mount = (first: string, second?: string) => {
  latest = first;
  act(() => root.render(<Harness first={first} second={second} />));
};
const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
  host.querySelector<T>(selector);
const click = (element: HTMLElement | null) => act(() => element!.click());
const view = () => EditorView.findFromDOM(q('.cm-editor')!)!;
const doc = () => view().state.doc.toString();
const status = () => q('[data-status-retired]');
const panel = () => q('#editor-panel-retired');
const fixes = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-retired-fix="${id}"]`)];

describe('retired markup in the editor', () => {
  it('shows the status item and wavy marks only while retired markup is in the text', () => {
    mount(rites);
    expect(status()?.textContent).toContain('2');
    expect(status()?.getAttribute('aria-label')).toBe('2 retired markup');
    const marks = [...host.querySelectorAll('.clarity-validation-retired')];
    expect(marks.map((mark) => mark.textContent).join('')).toContain('Solar Fulmination');
    expect(host.querySelector('.cm-content')?.textContent).not.toContain('<blue');
    // Yellow is never flagged.
    expect(marks.some((mark) => mark.textContent === 'it')).toBe(false);
  });

  it('never shows the item for clean text, and the markup issue count still counts the warning', () => {
    mount(clean);
    expect(status()).toBeNull();
    expect(q('.clarity-validation-retired')).toBeNull();
    act(() => root.render(<Harness first={rites} />));
  });

  it('lists each occurrence with the fixes in order and closes with Escape, returning focus', () => {
    mount(rites);
    click(status());
    expect(panel()).not.toBeNull();
    expect(status()?.getAttribute('aria-expanded')).toBe('true');
    const items = [...host.querySelectorAll('[data-retired-item]')];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Line 3');
    expect(items[0]!.textContent).toContain('<blue Solar Fulmination />');
    expect(items[1]!.textContent).toContain("<blue Hunter's Journal Artifact />");
    const labels = [...items[0]!.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toEqual(['Remove tag (keep the text)', 'Change to yellow']);
    expect(q('[data-retired-all]')?.textContent).toBe('Fix all (2)');
    act(() => {
      q('.cm-content')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(panel()).toBeNull();
  });

  it('closing a panel opened with the caret in the text returns focus to the text', () => {
    mount(rites);
    act(() => view().focus());
    click(status());
    expect(panel()).not.toBeNull();
    click(q('#editor-panel-retired button[aria-label^="Close"]'));
    expect(panel()).toBeNull();
    expect(view().hasFocus).toBe(true);
  });

  it('closing the retired panel never calls the editor focus itself (a phone tap must not raise the keyboard)', () => {
    mount(rites);
    const focus = vi.spyOn(EditorView.prototype, 'focus');
    click(status());
    click(q('#editor-panel-retired button[aria-label^="Close"]'));
    expect(panel()).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('cuts a long tag with an ellipsis and keeps the whole text as the title', () => {
    const long = `<blue ${'word '.repeat(20)}/>`;
    mount(long);
    click(status());
    const code = q('[data-retired-item] code')!;
    expect(code.textContent!.length).toBeLessThanOrEqual(40);
    expect(code.textContent).toMatch(/…$/);
    expect(code.getAttribute('title')).toBe(long);
  });

  it('fixes one form, updates the flag, and one undo restores the text', () => {
    mount(rites);
    click(status());
    click(fixes('remove-tag')[0]!);
    expect(doc()).toBe(
      "Daybreak.\n\nSolar Fulmination from the <blue Hunter's Journal Artifact /> doubles <yellow it />.",
    );
    expect(latest).toBe(doc());
    expect(status()?.getAttribute('aria-label')).toBe('1 retired markup');
    expect(host.querySelectorAll('[data-retired-item]')).toHaveLength(1);
    click(fixes('to-yellow')[0]!);
    expect(doc()).toContain("<yellow Hunter's Journal Artifact />");
    expect(status()).toBeNull();
    expect(panel()).toBeNull();
    act(() => {
      undo(view());
    });
    expect(doc()).toContain("<blue Hunter's Journal Artifact />");
    act(() => {
      undo(view());
    });
    expect(doc()).toBe(rites);
    expect(status()?.getAttribute('aria-label')).toBe('2 retired markup');
  });

  it('Fix all clears the text in one step, once, and one undo brings it all back', () => {
    mount(rites);
    click(status());
    click(q('[data-retired-all]'));
    expect(doc()).toBe(
      "Daybreak.\n\nSolar Fulmination from the Hunter's Journal Artifact doubles <yellow it />.",
    );
    expect(status()).toBeNull();
    expect(q('[data-retired-all]')).toBeNull();
    act(() => {
      undo(view());
    });
    expect(doc()).toBe(rites);
  });

  it('previews a structural fix before applying it, and Cancel changes nothing', () => {
    const text = 'Before\ncatalyst (\nonly catalyst text\n)\nAfter';
    mount(text);
    click(status());
    const remove = fixes('remove-block')[0]!;
    expect(q('[data-retired-all]')).toBeNull();
    click(remove);
    expect(doc()).toBe(text);
    const preview = q('[data-retired-preview]')!;
    expect(preview.textContent).toContain('only catalyst text');
    expect(preview.textContent).toContain('(nothing)');
    click([...preview.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
    expect(q('[data-retired-preview]')).toBeNull();
    // Keyboard focus is not lost: Cancel hands it back to the button that opened the preview.
    expect(document.activeElement).toBe(remove);
    expect(doc()).toBe(text);
    click(fixes('keep-contents')[0]!);
    expect(q('[data-retired-preview]')?.textContent).toContain('only catalyst text');
    click(q('[data-retired-apply]'));
    expect(doc()).toBe('Before\nonly catalyst text\nAfter');
    expect(status()).toBeNull();
    act(() => {
      undo(view());
    });
    expect(doc()).toBe(text);
  });

  it('stepping to another tooltip updates the flag and closes a panel that has nothing to show', () => {
    mount(rites, clean);
    click(status());
    expect(panel()).not.toBeNull();
    click(q('[data-step]'));
    expect(status()).toBeNull();
    expect(panel()).toBeNull();
    expect(q('.clarity-validation-retired')).toBeNull();
  });

  it('keeps the flag in the raw view and the symbol view', () => {
    mount(rites);
    act(() => {
      toggleRawView(view());
    });
    expect(host.querySelector('.cm-content')?.textContent).toContain('<blue Solar Fulmination />');
    expect(status()?.getAttribute('aria-label')).toBe('2 retired markup');
    expect(q('.clarity-validation-retired')).not.toBeNull();
    act(() => {
      toggleRawView(view());
    });
    expect(host.querySelector('.cm-content')?.textContent).not.toContain('<blue');
    expect(status()).not.toBeNull();
  });
});

describe('the colour-tag popover on a retired tag', () => {
  const text = 'x <blue ab /> y <yellow cd /> z';
  const key = (init: KeyboardEventInit) =>
    runScopeHandlers(
      view(),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      'editor',
    );
  const pin = (at: number) =>
    act(() =>
      view().dispatch({ selection: { anchor: at, head: at + 2 }, effects: pinTag.of(true) }),
    );
  const buttons = () =>
    [...host.querySelectorAll<HTMLElement>('.cm-symbol-fix')].map((button) => button.textContent);

  it('offers the same two fixes as the status bar, and only for a retired colour', () => {
    mount(text);
    pin(text.indexOf('cd'));
    expect(buttons()).toEqual([]);
    pin(text.indexOf('ab'));
    expect(host.querySelector('.cm-symbol-retired')?.textContent).toBe('Retired');
    expect(buttons()).toEqual(['Remove tag (keep the text)', 'Change to yellow']);
  });

  it('Change to yellow retags in place and keeps the tag pinned; undo restores it', () => {
    mount(text);
    pin(text.indexOf('ab'));
    click(host.querySelectorAll<HTMLElement>('.cm-symbol-fix')[1]!);
    expect(doc()).toBe('x <yellow ab /> y <yellow cd /> z');
    expect(buttons()).toEqual([]);
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<yellow … />');
    act(() => {
      undo(view());
    });
    expect(doc()).toBe(text);
  });

  it('Remove tag keeps the text, and Backspace still does the same', () => {
    mount(text);
    pin(text.indexOf('ab'));
    click(host.querySelectorAll<HTMLElement>('.cm-symbol-fix')[0]!);
    expect(doc()).toBe('x ab y <yellow cd /> z');
  });

  it('Backspace on the pinned retired tag removes it the same way', () => {
    mount(text);
    pin(text.indexOf('ab'));
    act(() => {
      key({ key: 'Backspace' });
    });
    expect(doc()).toBe('x ab y <yellow cd /> z');
  });

  it('hover only hints (the popover cannot be reached by the pointer); a read-only editor offers no fix', () => {
    mount(text);
    const tint = host.querySelector<HTMLElement>('.cm-tint-blue')!;
    vi.spyOn(view(), 'posAtCoords').mockReturnValue(text.indexOf('ab'));
    act(() => {
      tint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(host.querySelector('.cm-symbol-hint')?.textContent).toBe('Alt+click to fix');
    expect(buttons()).toEqual([]);
  });
});
