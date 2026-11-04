// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { readFileSync } from 'node:fs';
import { layoutKey as legacyKey, useSettingsStore } from '../../stores/settings';

const paneKey = 'editor:right';
let host: HTMLDivElement;
let root: Root;
let width = 1016;
let resize: () => void;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

function render(source = false) {
  act(() =>
    root.render(
      <VariantWorkspace
        editor={<div>Editor</div>}
        preview={<div>Preview</div>}
        source={source ? <div>Source</div> : undefined}
      />,
    ),
  );
  return host.querySelector('[role="separator"]') as HTMLDivElement;
}
function press(element: HTMLElement, keyName: string, init: KeyboardEventInit = {}) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...init }));
  });
}
const savedWidth = () => useSettingsStore.getState().device.panes[paneKey]?.width;

beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
  };
  vi.stubGlobal('localStorage', storage);
  // The settings store is one shared instance: start every test with no saved pane sizes.
  useSettingsStore.setState({ device: { ...useSettingsStore.getState().device, panes: {} } });
  width = 1016;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, left: 0 }) as DOMRect,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace divider', () => {
  it('retains split measurements and the selected pane while a navigation burst suspends work', () => {
    const show = (suspended: boolean) =>
      act(() =>
        root.render(
          <VariantWorkspace
            suspended={suspended}
            initialPanel="compendium"
            editor={<div>Editor</div>}
            compendium={suspended ? <div aria-busy="true" /> : <div>Compendium</div>}
          />,
        ),
      );
    show(false);
    const editor = host.querySelector('[data-panel="translation"]');
    expect(host.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('split');
    width = 0;
    show(true);
    expect(host.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('split');
    expect(host.querySelector('[data-view]')?.getAttribute('data-view')).toBe('compendium');
    width = 1016;
    show(false);
    expect(host.querySelector('[data-panel="translation"]')).toBe(editor);
    expect(host.querySelector('[data-view]')?.getAttribute('data-view')).toBe('compendium');
  });
  it('switches English panels with keyboard while retaining the editor', () => {
    render();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(['Editor', 'Preview']);
    const editor = host.querySelector('[data-panel="translation"]');
    tabs[0].focus();
    press(tabs[0], 'ArrowRight');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector('[data-panel="translation"]')).toBe(editor);
    press(tabs[1], 'Home');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });
  it('falls back to the editor when English disappears and keeps the tabs usable', () => {
    render(true);
    let tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(['Editor', 'Preview', 'English']);
    act(() => tabs[2].click());
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');

    render(false);
    tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(['Editor', 'Preview']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].tabIndex).toBe(0);
    expect(host.querySelector('[data-panel="translation"]')?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(host.querySelector('[data-panel="translation"]')?.textContent).toBe('Editor');

    act(() => tabs[1].click());
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-panel="preview"]')?.getAttribute('data-active')).toBe('true');

    render(true);
    tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });
  it('swaps the main slot from the pane header instead of stacking, keeping the editor mounted', () => {
    width = 700;
    act(() =>
      root.render(
        <VariantWorkspace
          header={<span>Header</span>}
          editor={<input aria-label="Editor field" />}
          source={<div>English text</div>}
          compendium={<div>Compendium text</div>}
        />,
      ),
    );
    const workspace = host.firstElementChild as HTMLElement;
    expect(workspace.getAttribute('data-mode')).toBe('toggle');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-toggles] button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['English', 'Compendium']);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
    ]);
    const field = host.querySelector('input')!;
    const panel = (name: string) => host.querySelector(`[data-panel="${name}"]`)!;
    expect(panel('translation').getAttribute('data-active')).toBe('true');
    expect(panel('compendium').getAttribute('data-active')).toBe('false');
    act(() => buttons[1].click());
    expect(panel('translation').getAttribute('data-active')).toBe('false');
    expect(panel('compendium').getAttribute('data-active')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    // The editor is hidden by CSS only: the same node, so caret and undo survive.
    expect(host.querySelector('input')).toBe(field);
    act(() => buttons[1].click());
    expect(panel('translation').getAttribute('data-active')).toBe('true');
    // Wide enough to split: the toggles go away and everything is on screen.
    width = 1016;
    act(() => resize());
    expect(workspace.getAttribute('data-mode')).toBe('split');
    expect(panel('compendium').getAttribute('data-active')).toBe('true');
    expect(host.querySelector('[data-toggles]')).not.toBeNull();
  });
  it('restores a saved width, clamps it to the container and responds to resize', () => {
    useSettingsStore.getState().setPane(paneKey, { width: 600, collapsed: false });
    const divider = render();
    // Container 1016 = 16px handle + 480px kept for the editor + at most 520px for the pane.
    expect(divider.getAttribute('aria-valuenow')).toBe('520');
    expect(divider.getAttribute('aria-valuemax')).toBe('520');
    expect(divider.getAttribute('aria-valuemin')).toBe('320');
    width = 836;
    act(() => resize());
    expect(divider.getAttribute('aria-valuenow')).toBe('340');
    // The narrow window clamped what is shown, not what was chosen.
    expect(savedWidth()).toBe(600);
    width = 1016;
    act(() => resize());
    expect(divider.getAttribute('aria-valuenow')).toBe('520');
  });
  it('sizes the pane 384px wide by default and never reads the old split percentage', () => {
    localStorage.setItem(legacyKey, '70');
    expect(render().getAttribute('aria-valuenow')).toBe('384');
    expect(localStorage.getItem(legacyKey)).toBe('70');
    expect(savedWidth()).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    storage.getItem.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(render().getAttribute('aria-valuenow')).toBe('384');
  });
  it('drops the divider where 480 + 320 do not fit (the pane is then a header toggle, not stacked)', () => {
    width = 700;
    const divider = render();
    expect(divider).toBeNull();
    const workspace = host.firstElementChild as HTMLElement;
    expect(workspace.hasAttribute('data-split')).toBe(false);
    // The editor and the pane are both still in the page.
    expect(host.querySelector('[data-panel="translation"]')?.textContent).toBe('Editor');
    expect(host.querySelector('[data-panel="preview"]')?.textContent).toBe('Preview');
    width = 1016;
    act(() => resize());
    expect(host.querySelector('[role="separator"]')).not.toBeNull();
    expect(workspace.hasAttribute('data-split')).toBe(true);
    expect(savedWidth()).toBeUndefined();
  });
  it('leaves the editor the whole width when there is no pane, and drops its tab', () => {
    act(() => root.render(<VariantWorkspace editor={<div>Editor</div>} preview={null} />));
    expect(host.querySelector('[role="separator"]')).toBeNull();
    expect(host.querySelector('[data-panel="preview"]')).toBeNull();
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Editor',
    ]);
  });
  it('moves by 8px, or 32px with Shift, respects bounds and resets on double click', () => {
    const divider = render(true);
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    // The pane is on the right, so the handle moving left makes it wider.
    press(divider, 'ArrowLeft');
    expect(divider.getAttribute('aria-valuenow')).toBe('392');
    expect(savedWidth()).toBe(392);
    press(divider, 'ArrowLeft', { shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('424');
    press(divider, 'End');
    press(divider, 'ArrowLeft');
    expect(divider.getAttribute('aria-valuenow')).toBe('520');
    press(divider, 'Home');
    press(divider, 'ArrowRight');
    expect(divider.getAttribute('aria-valuenow')).toBe('320');
    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(divider.getAttribute('aria-valuenow')).toBe('384');
    expect(useSettingsStore.getState().device.panes[paneKey]).toBeUndefined();
    expect(host.querySelector('[data-panel="source"]')?.textContent).toBe('Source');
  });
  it('suppresses selection only for resizing and retains separator focus', () => {
    const divider = render();
    divider.setPointerCapture = vi.fn();
    const primary = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(primary, 'pointerId', { value: 7 });
    act(() => {
      divider.dispatchEvent(primary);
    });
    expect(primary.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(divider);
    const secondary = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 });
    act(() => {
      divider.dispatchEvent(secondary);
    });
    expect(secondary.defaultPrevented).toBe(false);
    const editor = host.firstElementChild!.firstElementChild!;
    const normal = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      editor.dispatchEvent(normal);
    });
    expect(normal.defaultPrevented).toBe(false);
  });
  it('stops dragging after pointer cancellation without saving', () => {
    const divider = render();
    divider.setPointerCapture = vi.fn();
    divider.hasPointerCapture = vi.fn(() => true);
    divider.releasePointerCapture = vi.fn();
    function pointer(type: string, clientX: number) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      act(() => {
        divider.dispatchEvent(event);
      });
    }
    pointer('pointerdown', 608);
    pointer('pointermove', 508);
    expect(divider.getAttribute('aria-valuenow')).toBe('484');
    pointer('pointercancel', 508);
    expect(divider.getAttribute('aria-valuenow')).toBe('384');
    pointer('pointermove', 408);
    expect(divider.getAttribute('aria-valuenow')).toBe('384');
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(useSettingsStore.getState().device.panes[paneKey]).toBeUndefined();
  });
  it('keeps the divider hidden unless the workspace is split, and stacked otherwise', () => {
    const css = readFileSync('apps/web/src/features/tooltip/TooltipPage.module.scss', 'utf8');
    expect(css).toMatch(/\.divider\s*\{\s*display: none/);
    expect(css).toMatch(
      /\.workspace\[data-split\]\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 1rem var\(--right-width\)/,
    );
    expect(css).toMatch(/\.workspace\[data-split\][\s\S]*?\.divider\s*\{\s*display: block/);
  });
  it('keeps the phone tabs sticky and 44px, and the pane header to one 28px line on desktop', () => {
    const tooltipCss = readFileSync(
      'apps/web/src/features/tooltip/TooltipPage.module.scss',
      'utf8',
    );
    const layoutCss = readFileSync('apps/web/src/features/navigation/Layout.module.scss', 'utf8');
    expect(tooltipCss).toMatch(/\.tabs\s*\{[\s\S]*?min-height:\s*max\(44px, 2\.75rem\)/);
    expect(tooltipCss).toMatch(/\.tabs\s*\{[\s\S]*?position:\s*sticky/);
    // The phone tabs stick below the 48px header, and the editor page gives its text the room.
    expect(tooltipCss).toMatch(/\.tabs\s*\{[\s\S]*?top:\s*3rem/);
    expect(tooltipCss).toMatch(/\.paneHeader\s*\{[\s\S]*?min-height:\s*1\.75rem/);
    expect(tooltipCss).toMatch(/\.paneHeader\s*\{[\s\S]*?white-space:\s*nowrap/);
    expect(layoutCss).toMatch(/\.editorMode \.main \{[^}]*padding-top:\s*0\.25rem/);
  });
});
