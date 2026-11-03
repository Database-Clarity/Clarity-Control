// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { readFileSync } from 'node:fs';
import { layoutKey as legacyKey, useSettingsStore } from '../../stores/settings';

const paneKey = 'workspace:editor';
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
  it('falls back to the editor when Source disappears and keeps the tabs usable', () => {
    render(true);
    let tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(['Source', 'Editor', 'Preview']);
    act(() => tabs[0].click());
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

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
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  });
  it('restores a saved width, clamps it to the container and responds to resize', () => {
    useSettingsStore.getState().setPane(paneKey, { width: 900, collapsed: false });
    const divider = render();
    // Container 1016 = 16px handle + 240px kept for the preview + at most 760px for the editor.
    expect(divider.getAttribute('aria-valuenow')).toBe('760');
    expect(divider.getAttribute('aria-valuemax')).toBe('760');
    width = 616;
    act(() => resize());
    expect(divider.getAttribute('aria-valuenow')).toBe('360');
    // The narrow window clamped what is shown, not what was chosen.
    expect(savedWidth()).toBe(900);
    width = 1016;
    act(() => resize());
    expect(divider.getAttribute('aria-valuenow')).toBe('760');
  });
  it('falls back to an even split for an invalid legacy value or unavailable storage', () => {
    localStorage.setItem(legacyKey, 'NaN');
    expect(render().getAttribute('aria-valuenow')).toBe('500');
    expect(localStorage.getItem(legacyKey)).toBe('NaN');
    act(() => root.unmount());
    root = createRoot(host);
    storage.getItem.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(render().getAttribute('aria-valuenow')).toBe('500');
  });
  it('converts the old percentage once and never overwrites the new key afterwards', () => {
    localStorage.setItem(legacyKey, '70');
    const divider = render();
    expect(divider.getAttribute('aria-valuenow')).toBe('700');
    expect(useSettingsStore.getState().device.panes[paneKey]).toEqual({
      width: 700,
      collapsed: false,
    });
    expect(localStorage.getItem(legacyKey)).toBeNull();
    useSettingsStore.getState().setPane(paneKey, { width: 400, collapsed: false });
    localStorage.setItem(legacyKey, '90');
    act(() => root.unmount());
    root = createRoot(host);
    expect(render().getAttribute('aria-valuenow')).toBe('400');
    expect(savedWidth()).toBe(400);
  });
  it('waits for a measurable container before converting, and writes nothing on a narrow screen', () => {
    localStorage.setItem(legacyKey, '70');
    width = 400;
    render();
    expect(savedWidth()).toBeUndefined();
    expect(localStorage.getItem(legacyKey)).toBe('70');
    width = 1016;
    act(() => resize());
    expect(savedWidth()).toBe(700);
  });
  it('moves by 8px, or 32px with Shift, respects bounds and resets on double click', () => {
    const divider = render(true);
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    press(divider, 'ArrowRight');
    expect(divider.getAttribute('aria-valuenow')).toBe('508');
    expect(savedWidth()).toBe(508);
    press(divider, 'ArrowRight', { shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('540');
    press(divider, 'End');
    press(divider, 'ArrowRight');
    expect(divider.getAttribute('aria-valuenow')).toBe('760');
    press(divider, 'Home');
    press(divider, 'ArrowLeft');
    expect(divider.getAttribute('aria-valuenow')).toBe('240');
    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(divider.getAttribute('aria-valuenow')).toBe('500');
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
    pointer('pointerdown', 508);
    pointer('pointermove', 608);
    expect(divider.getAttribute('aria-valuenow')).toBe('600');
    pointer('pointercancel', 608);
    expect(divider.getAttribute('aria-valuenow')).toBe('500');
    pointer('pointermove', 708);
    expect(divider.getAttribute('aria-valuenow')).toBe('500');
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(useSettingsStore.getState().device.panes[paneKey]).toBeUndefined();
  });
  it('keeps the divider hidden and the original stacked rules below the desktop breakpoint', () => {
    const css = readFileSync('apps/web/src/features/tooltip/TooltipPage.module.scss', 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 1000px\)\s*\{\s*\.columns\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(css).toMatch(
      /@media \(max-width: 1000px\)\s*\{\s*\.workspace\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(css).toMatch(/\.divider\s*\{\s*display: none/);
    expect(css).toMatch(/@media \(min-width: 1001px\)[\s\S]*\.divider\s*\{\s*display: block/);
  });
  it('keeps phone identity disclosures and panel controls compact and reachable', () => {
    const tooltipCss = readFileSync(
      'apps/web/src/features/tooltip/TooltipPage.module.scss',
      'utf8',
    );
    const layoutCss = readFileSync('apps/web/src/features/navigation/Layout.module.scss', 'utf8');
    expect(tooltipCss).toMatch(/\.phoneMeta summary\s*\{[\s\S]*?min-height:\s*44px/);
    expect(tooltipCss).toMatch(/\.tabs\s*\{[\s\S]*?position:\s*sticky/);
    expect(tooltipCss).toMatch(/\.primaryMetadata,[\s\S]*?display:\s*none/);
    // The phone tabs stick below the 48px header, and the editor page gives its text the room.
    expect(tooltipCss).toMatch(/\.tabs\s*\{[\s\S]*?top:\s*48px/);
    expect(layoutCss).toMatch(/\.editorMode \.main \{[^}]*padding-top:\s*0\.25rem/);
  });
});
