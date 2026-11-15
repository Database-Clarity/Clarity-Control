// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Overlay, StatusBar } from './StatusBar';
import { ClarityEditor } from './ClarityEditor';

let host: HTMLDivElement;
let root: Root;
const render = (node: ReactNode) => act(() => root.render(node));
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const click = (element: HTMLElement | null) => act(() => element!.click());

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

const bar = (props: Partial<ComponentProps<typeof StatusBar>> = {}) => (
  <StatusBar
    readOnlyReason={null}
    issues={[]}
    glyphCount={0}
    line={3}
    column={7}
    panel={null}
    onPanel={() => undefined}
    {...props}
  />
);

describe('status bar', () => {
  it('shows the position, the help button and no warning items when all is well', () => {
    render(bar());
    expect(q('[data-editor-status]')?.textContent).toContain('Ln 3, Col 7');
    expect(host.textContent).toContain('Markup help');
    expect(host.textContent).not.toContain('character warning');
    // Issues have their own item, shown only while there are some.
    expect(q('[data-status-issues]')).toBeNull();
    expect(host.textContent).not.toContain('Show preview');
    expect(q('[data-status-reason]')).toBeNull();
  });

  it('says why the text is read only, counts markup issues and glyph warnings', () => {
    render(
      bar({
        readOnlyReason: 'Archived tooltip - read only',
        issues: [
          { severity: 'error', message: 'Unclosed tag', from: 0, to: 1 },
          { severity: 'warning', message: 'Odd glyph', from: 2, to: 3 },
        ],
        glyphCount: 2,
      }),
    );
    expect(q('[data-status-reason]')?.textContent).toBe('Archived tooltip - read only');
    expect(q('[data-status-issues]')?.textContent).toBe('2 issues');
    expect(q('[data-status-help]')?.textContent).toBe('Markup helpHelp');
    expect(host.textContent).toContain('2 character warnings');
    expect(q('[data-severity="error"]')).not.toBeNull();
  });

  it('steps its labels down only as far as the items need to fit, and back up when they fit', () => {
    // jsdom has no layout: each step takes 60px off a 400px row of items in a 300px bar.
    const widths = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return 400 - 60 * Number(this.dataset.fit ?? 0);
      });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const status = () => q('[data-editor-status]')!;
    render(bar({ issues: [{ severity: 'warning', message: 'x', from: 0, to: 1 }] }));
    expect(status().dataset.fit).toBe('2');
    // Fewer items: back to the widest step that fits.
    widths.mockImplementation(function (this: HTMLElement) {
      return 280 - 60 * Number(this.dataset.fit ?? 0);
    });
    render(bar());
    expect(status().dataset.fit).toBe('0');
    // Never past the last step, even if that still does not fit.
    widths.mockReturnValue(1000);
    render(bar({ glyphCount: 2 }));
    expect(status().dataset.fit).toBe('5');
    // A read-only reason cut short steps down as far as the short labels, never further.
    widths.mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-status-reason]') ? 900 : 200;
    });
    render(bar({ readOnlyReason: 'Paused: another tab changed your drafts.' }));
    expect(status().dataset.fit).toBe('2');
    // A shown preview item squeezed below its content counts as crowded (its key hint would draw
    // over the position); an idle, unreserved one may shrink freely.
    const onShow = () => undefined;
    widths.mockImplementation(function (this: HTMLElement) {
      if (!this.matches('[data-status-preview]')) return 200;
      return Number(this.closest<HTMLElement>('[data-editor-status]')!.dataset.fit) < 4 ? 900 : 200;
    });
    render(bar({ readOnlyReason: null, preview: { unpreviewed: 1, collapsed: false, onShow } }));
    expect(status().dataset.fit).toBe('4');
    root.unmount();
    root = createRoot(host);
    render(bar({ preview: { unpreviewed: 0, collapsed: false, onShow } }));
    expect(status().dataset.fit).toBe('0');
    // The counts keep their words for the text and their full names for assistive technology.
    render(bar({ issues: [{ severity: 'error', message: 'x', from: 0, to: 1 }], glyphCount: 2 }));
    expect(q('[data-status-issues]')?.textContent).toBe('1 issue');
    expect(q('[data-status-issues]')?.getAttribute('aria-label')).toBe('1 markup issue');
    // A caret move alone never measures.
    const measured = widths.mock.calls.length;
    render(
      bar({
        issues: [{ severity: 'error', message: 'x', from: 0, to: 1 }],
        glyphCount: 2,
        line: 9,
      }),
    );
    expect(widths.mock.calls.length).toBe(measured);
    vi.restoreAllMocks();
  });

  it('fits after the browser lays the bar out, never inside the render that mounts it', () => {
    let report: (() => void) | undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          report = () => callback([], this as unknown as ResizeObserver);
        }
        observe(element: Element) {
          observed.push(element);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const widths = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return 400 - 60 * Number(this.dataset.fit ?? 0);
      });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const status = () => q('[data-editor-status]')!;
    render(bar({ issues: [{ severity: 'warning', message: 'x', from: 0, to: 1 }] }));
    expect(widths).not.toHaveBeenCalled();
    act(() => report!());
    expect(status().dataset.fit).toBe('2');
    // The same size again (its own steps): nothing to do.
    const measured = widths.mock.calls.length;
    act(() => report!());
    expect(widths.mock.calls.length).toBe(measured);
    // New items: observed afresh, measured when the observer reports after the next layout.
    widths.mockImplementation(function (this: HTMLElement) {
      return 280 - 60 * Number(this.dataset.fit ?? 0);
    });
    const observations = observed.length;
    render(bar());
    expect(widths.mock.calls.length).toBe(measured);
    expect(observed.length).toBe(observations + 1);
    act(() => report!());
    expect(status().dataset.fit).toBe('0');
    vi.restoreAllMocks();
  });

  it('drops a preview count whole when the short labels still cut it, never showing a fragment', () => {
    // jsdom has no layout: the count text is cut while the bar is narrower than it needs.
    const onShow = () => undefined;
    const status = () => q('[data-editor-status]')!;
    let countFitsFrom = Infinity;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.matches('[data-status-preview-text]')) return 200;
      const bar = this.closest<HTMLElement>('[data-editor-status]')!;
      if (bar.hasAttribute('data-count-dropped')) return 0;
      return Number(bar.dataset.fit) >= countFitsFrom ? 100 : 900;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.matches('[data-status-preview-text]') ? 120 : 300;
    });
    // The short labels make room for it: it stays, whole.
    countFitsFrom = 1;
    render(bar({ preview: { unpreviewed: 1, collapsed: false, onShow } }));
    expect(status().dataset.fit).toBe('1');
    expect(status().hasAttribute('data-count-dropped')).toBe(false);
    // A longer count no longer fits at any label step: it drops whole, and the labels, which fit
    // without it, go back to their widest.
    countFitsFrom = Infinity;
    render(bar({ preview: { unpreviewed: 12, collapsed: false, onShow } }));
    expect(status().hasAttribute('data-count-dropped')).toBe(true);
    expect(status().dataset.fit).toBe('0');
    // The button stays, with the full count in its title.
    expect(q('[data-status-preview] button')?.title).toBe('12 changes not previewed');
    expect(q('[data-status-preview] button')?.hasAttribute('disabled')).toBe(false);
    // Room again (a wider bar or a shorter count): it comes back.
    countFitsFrom = 0;
    render(bar({ preview: { unpreviewed: 3, collapsed: false, onShow } }));
    expect(status().hasAttribute('data-count-dropped')).toBe(false);
    expect(status().dataset.fit).toBe('0');
    vi.restoreAllMocks();
  });

  it('offers the preview when edits were not previewed or the column is hidden', () => {
    const onShow = vi.fn();
    render(bar({ preview: { unpreviewed: 2, collapsed: true, onShow } }));
    expect(host.textContent).toContain('2 not previewed');
    click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show preview'))!,
    );
    expect(onShow).toHaveBeenCalledTimes(1);
    render(bar({ preview: { unpreviewed: 1, collapsed: false, onShow } }));
    expect(host.textContent).toContain('1 not previewed');
    render(bar({ preview: { unpreviewed: 0, collapsed: true, onShow } }));
    expect(host.textContent).toContain('Preview hidden');
    render(bar({ preview: { unpreviewed: 0, collapsed: false, onShow } }));
    expect(q('[data-status-preview]')?.getAttribute('data-inactive')).toBe('true');
    expect(q('[data-status-preview] button')?.hasAttribute('disabled')).toBe(true);
  });

  it('lends the idle preview room to the labels until the preview first shows for that text', () => {
    const onShow = vi.fn();
    const review = (canonical: number) => ({ canonical, scheduled: [], visible: true });
    const reserved = () => q('[data-status-preview]')?.hasAttribute('data-reserved');
    render(bar({ preview: { review: review(1), collapsed: false, onShow } }));
    expect(reserved()).toBe(false);
    render(bar({ preview: { review: review(1), collapsed: true, onShow } }));
    expect(reserved()).toBe(true);
    // Idle again: it keeps its room, so the labels do not change back and forth.
    render(bar({ preview: { review: review(1), collapsed: false, onShow } }));
    expect(q('[data-status-preview]')?.hasAttribute('data-inactive')).toBe(true);
    expect(reserved()).toBe(true);
    // Another text starts unreserved.
    render(bar({ preview: { review: review(2), collapsed: false, onShow } }));
    expect(reserved()).toBe(false);
  });

  it('toggles a panel through its button', () => {
    const onPanel = vi.fn();
    render(bar({ panel: 'help', onPanel }));
    const help = host.querySelector<HTMLElement>('button[aria-controls="editor-panel-help"]')!;
    expect(help.getAttribute('aria-expanded')).toBe('true');
    click(help);
    expect(onPanel).toHaveBeenCalledWith(null);
  });
});

describe('editor overlays', () => {
  const editor = (value: string) => (
    <ClarityEditor
      value={value}
      lang="en"
      onChange={() => undefined}
      globals={{ variables: '', titles: '' }}
      readOnlyReason="Read only"
    />
  );

  it('opens the glyph panel over the text, not inside it, and never touches the text', () => {
    // U+1F81A (an arrow) is not a vetted game glyph, so it warns and offers a replacement.
    render(editor('Deals 20% \u{1F81A} 30%'));
    const content = q('.cm-content')!;
    const before = content.textContent;
    expect(q('[data-editor-overlay]')).toBeNull();
    click(host.querySelector('button[aria-controls="editor-panel-glyphs"]'));
    const overlay = q('[data-editor-overlay]')!;
    expect(overlay.id).toBe('editor-panel-glyphs');
    expect(overlay.closest('.cm-editor')).toBeNull();
    expect(host.querySelector('[data-editor-root]')?.contains(overlay)).toBe(true);
    expect(q('[data-editor-overlay]')?.textContent).toContain('Replace first');
    expect(q('.cm-content')).toBe(content);
    expect(content.textContent).toBe(before);
    click(q('[data-editor-overlay] button[aria-label^="Close"]'));
    expect(q('[data-editor-overlay]')).toBeNull();
  });

  it('closes a panel with Escape in the text before Escape does anything else', () => {
    render(editor('Deals 20% \u{1F81A} damage'));
    click(host.querySelector('button[aria-controls="editor-panel-glyphs"]'));
    expect(q('[data-editor-overlay]')).not.toBeNull();
    const content = q('.cm-content')!;
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(q('[data-editor-overlay]')).toBeNull();
  });

  it('reports the caret position', () => {
    render(editor('one\ntwo'));
    expect(q('[data-editor-status]')?.textContent).toContain('Ln 1, Col 1');
  });
});

describe('overlay focus', () => {
  const panel = (onClose = () => undefined) => (
    <>
      <div data-editor-status>
        <button id="opener">open</button>
      </div>
      <Overlay id="p" label="Panel" onClose={onClose}>
        <button>inside</button>
      </Overlay>
    </>
  );

  it('takes focus from the bar item that opened it and gives it back on Escape and Close', () => {
    const opener = document.createElement('button');
    opener.dataset.editorStatus = '';
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    render(panel(onClose));
    expect(document.activeElement).toBe(q('#p'));
    act(() => {
      q('#p')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    click(q('#p button[aria-label="Close Panel"]'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('never moves focus when nothing had it (a phone tap): closing leaves it alone', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const before = document.activeElement;
    render(panel());
    expect(document.activeElement).toBe(before);
    click(q('#p button[aria-label="Close Panel"]'));
    expect(document.activeElement).toBe(before);
  });
});
