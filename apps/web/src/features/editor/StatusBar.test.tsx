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
    expect(status().dataset.fit).toBe('3');
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
