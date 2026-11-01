// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { readFileSync } from 'node:fs';

const key = 'description-editor-split';
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
function press(element: HTMLElement, keyName: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

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
    expect([...tabs].map((tab) => tab.textContent)).toEqual(['Source', 'Preview']);
    const editor = host.querySelector('[data-panel="translation"]');
    tabs[0].focus();
    press(tabs[0], 'ArrowRight');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector('[data-panel="translation"]')).toBe(editor);
    press(tabs[1], 'Home');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });
  it('restores a saved split, clamps to the container and responds to resize', () => {
    localStorage.setItem(key, '90');
    const divider = render();
    expect(divider.getAttribute('aria-valuenow')).toBe('76');
    expect(divider.getAttribute('aria-valuemax')).toBe('76');
    width = 616;
    act(() => resize());
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
  });
  it('falls back for invalid and unavailable storage', () => {
    localStorage.setItem(key, 'NaN');
    expect(render().getAttribute('aria-valuenow')).toBe('50');
    act(() => root.unmount());
    root = createRoot(host);
    storage.getItem.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(render().getAttribute('aria-valuenow')).toBe('50');
  });
  it('persists keyboard changes, respects bounds and resets on double click', () => {
    const divider = render(true);
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    press(divider, 'ArrowRight');
    expect(localStorage.getItem(key)).toBe('52');
    press(divider, 'End');
    press(divider, 'ArrowRight');
    expect(divider.getAttribute('aria-valuenow')).toBe('76');
    press(divider, 'Home');
    press(divider, 'ArrowLeft');
    expect(divider.getAttribute('aria-valuenow')).toBe('24');
    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    expect(localStorage.getItem(key)).toBeNull();
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
  it('stops dragging after pointer cancellation', () => {
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
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
    pointer('pointercancel', 608);
    pointer('pointermove', 708);
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
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
});
