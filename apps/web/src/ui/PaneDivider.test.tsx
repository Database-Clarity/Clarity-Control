// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../stores/settings';
import { PaneDivider } from './PaneDivider';
import { usePaneDivider, type PaneDividerOptions } from './usePaneDivider';

type Options = Partial<PaneDividerOptions>;
const key = 'editor:left';
let host: HTMLDivElement;
let root: Root;
let containerWidth = 1280;
let notify: (entries?: ResizeObserverEntry[]) => void = () => {};
let disconnected = 0;

function Harness(options: Options) {
  const { columns = true, ...rest } = options as Options & { columns?: boolean };
  const pane = usePaneDivider({
    storeKey: key,
    sizes: 'start',
    min: 280,
    max: 480,
    defaultWidth: 336,
    reserve: 480,
    ...rest,
  });
  if (!columns) return <output data-width>{pane.width}</output>;
  return (
    <div ref={pane.containerRef}>
      <output data-width>{pane.width}</output>
      <PaneDivider {...pane.divider} label="Resize left column" />
    </div>
  );
}
function render(options: Options & { columns?: boolean } = {}) {
  act(() => root.render(<Harness {...options} />));
  return host.querySelector('[role="separator"]') as HTMLDivElement;
}
const shown = () => Number(host.querySelector('[data-width]')?.textContent);
const stored = () => useSettingsStore.getState().device.panes[key];
function press(element: HTMLElement, name: string, init: KeyboardEventInit = {}) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
  });
}
function pointer(element: HTMLElement, type: string, clientX: number, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    ...init,
  });
  Object.defineProperty(event, 'pointerId', { value: 3 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}
function capturing(element: HTMLElement) {
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
  element.releasePointerCapture = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  containerWidth = 1280;
  disconnected = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        notify = (entries = []) => callback(entries);
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: containerWidth, left: 0 }) as DOMRect,
  );
  useSettingsStore.setState({ device: { ...useSettingsStore.getState().device, panes: {} } });
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

describe('PaneDivider', () => {
  it('is a labelled vertical separator with the pane width as its value', () => {
    const divider = render();
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-label')).toBe('Resize left column');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute('aria-valuemin')).toBe('280');
    expect(divider.getAttribute('aria-valuemax')).toBe('480');
    expect(divider.getAttribute('aria-valuenow')).toBe('336');
    expect(divider.hasAttribute('aria-expanded')).toBe(false);
  });

  it('takes its first width synchronously, before any interaction', () => {
    useSettingsStore.getState().setPane(key, { width: 400, collapsed: false });
    render();
    expect(shown()).toBe(400);
  });

  it('resumes at its known width and clamps from observer bounds without forcing layout', () => {
    useSettingsStore.getState().setPane(key, { width: 440, collapsed: false });
    render();
    expect(shown()).toBe(440);
    render({ paused: true });
    const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    geometry.mockClear();
    containerWidth = 900;
    render({ paused: false });
    expect(geometry).not.toHaveBeenCalled();
    expect(shown()).toBe(440);
    act(() =>
      notify([
        { borderBoxSize: [{ inlineSize: 900, blockSize: 500 }] } as unknown as ResizeObserverEntry,
      ]),
    );
    expect(shown()).toBe(404);
    expect(stored()?.width).toBe(440);
    expect(geometry).not.toHaveBeenCalled();
  });

  it('measures and observes a container that mounts after measuring resumed (skeleton)', () => {
    useSettingsStore.getState().setPane(key, { width: 600, collapsed: false });
    const defaultWidth = (width: number) => (width ? Math.round(width / 3) : 280);
    // Unpaused, but a skeleton is still up: no container yet.
    render({ columns: false, defaultWidth, max: 2000 });
    containerWidth = 1000;
    render({ defaultWidth, max: 2000 });
    // Saved 600 is clamped to the measured room: 1000 - 480 reserve - 16 track.
    expect(shown()).toBe(504);
    act(() => useSettingsStore.getState().setPane(key, null));
    expect(shown()).toBe(333);
    act(() =>
      notify([
        { borderBoxSize: [{ inlineSize: 1200, blockSize: 500 }] } as unknown as ResizeObserverEntry,
      ]),
    );
    expect(shown()).toBe(400);
    act(() => useSettingsStore.getState().setPane(key, { width: 900, collapsed: false }));
    act(() =>
      notify([
        { borderBoxSize: [{ inlineSize: 800, blockSize: 500 }] } as unknown as ResizeObserverEntry,
      ]),
    );
    expect(shown()).toBe(304);
  });

  it('moves 8px per arrow and 32px with Shift, and stops at the limits', () => {
    const divider = render();
    press(divider, 'ArrowRight');
    expect(shown()).toBe(344);
    press(divider, 'ArrowRight', { shiftKey: true });
    expect(shown()).toBe(376);
    press(divider, 'ArrowLeft');
    expect(shown()).toBe(368);
    for (let index = 0; index < 10; index++) press(divider, 'ArrowRight', { shiftKey: true });
    expect(shown()).toBe(480);
    expect(stored()?.width).toBe(480);
    press(divider, 'Home');
    expect(shown()).toBe(280);
    press(divider, 'ArrowLeft');
    expect(shown()).toBe(280);
  });

  it('ignores arrows with Ctrl, Alt or Meta so browser and screen-reader shortcuts keep working', () => {
    const divider = render();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true });
    act(() => {
      divider.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(stored()).toBeUndefined();
  });

  describe('at another interface scale', () => {
    // The settings store re-applies the real root font size on every device change, so the root
    // size is stubbed here (as the browser would compute it) and announced like the store does.
    let rootPx = 16;
    const setRoot = (px: number) => {
      rootPx = px;
      act(() => void window.dispatchEvent(new Event('clarity-ui-scale')));
    };
    beforeEach(() => {
      rootPx = 16;
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
        element === document.documentElement
          ? ({ fontSize: `${rootPx}px` } as CSSStyleDeclaration)
          : real(element, pseudo),
      );
      // The factor is read once per announcement, so a fresh stub is announced too.
      setRoot(16);
    });

    it('scales limits, the default and the saved size from design pixels, and follows a scale change', () => {
      containerWidth = 1920;
      setRoot(24); // 150 %
      const divider = render({ sizes: 'end', min: 320, max: 640, defaultWidth: 384 });
      expect(shown()).toBe(576);
      expect(divider.getAttribute('aria-valuemin')).toBe('480');
      expect(divider.getAttribute('aria-valuemax')).toBe('960');
      // A saved size is design pixels: 400 is 600 on screen at 150 %, and 340 at 85 %.
      act(() => useSettingsStore.getState().setPane(key, { width: 400, collapsed: false }));
      expect(shown()).toBe(600);
      setRoot(13.6);
      expect(shown()).toBe(340);
      setRoot(16);
      expect(shown()).toBe(400);
    });

    it('saves a keyboard resize in design pixels, so another scale shows the same share', () => {
      containerWidth = 1920;
      setRoot(24);
      const divider = render({ sizes: 'end', min: 320, max: 640, defaultWidth: 384 });
      press(divider, 'ArrowLeft'); // one 8px design step = 12px on screen
      expect(shown()).toBe(588);
      expect(stored()).toEqual({ width: 392, collapsed: false });
      setRoot(16);
      expect(shown()).toBe(392);
    });

    it('reads the root size once per announcement, not on every pane mount', () => {
      const rootReads = () =>
        vi
          .mocked(window.getComputedStyle)
          .mock.calls.filter(([element]) => element === document.documentElement).length;
      containerWidth = 1920;
      const before = rootReads();
      const pane = { sizes: 'end', min: 320, max: 640, defaultWidth: 384 } as const;
      act(() =>
        root.render(
          <>
            <Harness {...pane} />
            <Harness {...pane} />
          </>,
        ),
      );
      expect(rootReads()).toBe(before + 1);
      expect(shown()).toBe(384);
      setRoot(24);
      expect(rootReads()).toBe(before + 2);
      expect(shown()).toBe(576);
    });

    it('keeps the editor its minimum share: the viewport clamp uses scaled reserve and divider', () => {
      setRoot(24);
      containerWidth = 1500;
      render({ sizes: 'end', min: 320, max: 640, defaultWidth: 640, reserve: 480 });
      // 1500 - 480*1.5 reserve - 16*1.5 divider = 756 available; the pane wants 960.
      expect(shown()).toBe(756);
    });
  });

  it('reverses the arrows for a pane after the divider', () => {
    const divider = render({ sizes: 'end', min: 320, max: 640, defaultWidth: 384 });
    expect(shown()).toBe(384);
    press(divider, 'ArrowLeft');
    expect(shown()).toBe(392);
    press(divider, 'ArrowRight', { shiftKey: true });
    expect(shown()).toBe(360);
  });

  it('uses Home and End as the smallest and largest size when the pane cannot collapse', () => {
    const divider = render();
    press(divider, 'Enter');
    expect(stored()).toBeUndefined();
    press(divider, 'Home');
    expect(shown()).toBe(280);
    press(divider, 'End');
    expect(shown()).toBe(480);
    expect(divider.hasAttribute('aria-expanded')).toBe(false);
  });

  it('collapses on Home or Enter, restores on End, Enter or the growing arrow, only when asked', () => {
    const divider = render({ collapsible: true });
    press(divider, 'ArrowRight', { shiftKey: true });
    expect(shown()).toBe(368);
    press(divider, 'Home');
    expect(shown()).toBe(0);
    expect(divider.getAttribute('aria-expanded')).toBe('false');
    expect(divider.getAttribute('aria-valuenow')).toBe('0');
    expect(divider.getAttribute('aria-valuemin')).toBe('0');
    expect(stored()).toEqual({ width: 368, collapsed: true, lastExpanded: 368 });
    // The shrinking arrow never reaches zero by itself, and does nothing while collapsed.
    press(divider, 'ArrowLeft');
    expect(shown()).toBe(0);
    press(divider, 'End');
    expect(shown()).toBe(368);
    expect(divider.getAttribute('aria-expanded')).toBe('true');
    press(divider, 'Enter');
    expect(shown()).toBe(0);
    press(divider, 'ArrowRight');
    expect(shown()).toBe(368);
    press(divider, 'Enter');
    press(divider, 'Enter');
    expect(shown()).toBe(368);
  });

  it('never goes below the minimum by shrinking, even when collapsible', () => {
    const divider = render({ collapsible: true });
    press(divider, 'Home');
    press(divider, 'End');
    for (let index = 0; index < 20; index++) press(divider, 'ArrowLeft', { shiftKey: true });
    expect(shown()).toBe(280);
    expect(stored()?.collapsed).toBe(false);
  });

  it('shows a clamped width on a narrow container without overwriting the chosen one', () => {
    useSettingsStore.getState().setPane(key, { width: 440, collapsed: false });
    containerWidth = 900;
    const divider = render();
    // 900 - 480 for the main pane - 16 for the handle = 404 available.
    expect(shown()).toBe(404);
    expect(divider.getAttribute('aria-valuemax')).toBe('404');
    expect(stored()?.width).toBe(440);
    containerWidth = 1280;
    act(() => notify());
    expect(shown()).toBe(440);
    containerWidth = 700;
    act(() => notify());
    // Even the minimum no longer fits: the main pane keeps its width, this pane gives way.
    expect(shown()).toBe(204);
    expect(divider.getAttribute('aria-valuemin')).toBe('204');
    expect(stored()?.width).toBe(440);
  });

  it('resets to the default on double click and removes only its own saved size', () => {
    useSettingsStore.getState().setPane('editor:right', { width: 500, collapsed: false });
    const divider = render();
    press(divider, 'ArrowRight');
    expect(stored()?.width).toBe(344);
    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(shown()).toBe(336);
    expect(stored()).toBeUndefined();
    expect(useSettingsStore.getState().device.panes['editor:right']?.width).toBe(500);
  });

  it('follows Reset pane widths at once', () => {
    useSettingsStore.getState().setPane(key, { width: 450, collapsed: false });
    render();
    expect(shown()).toBe(450);
    act(() => {
      useSettingsStore.getState().resetPaneWidths();
    });
    expect(shown()).toBe(336);
  });

  it('keeps its size in memory only when persistence is off (phone)', () => {
    const divider = render({ persist: false });
    useSettingsStore.getState().setPane(key, { width: 450, collapsed: false });
    expect(shown()).toBe(336);
    press(divider, 'ArrowRight');
    expect(shown()).toBe(344);
    expect(stored()?.width).toBe(450);
  });

  it('drags by the pointer distance and saves once, on release', () => {
    const divider = render();
    capturing(divider);
    const down = pointer(divider, 'pointerdown', 340);
    expect(down.defaultPrevented).toBe(true);
    expect(divider.setPointerCapture).toHaveBeenCalledWith(3);
    expect(document.activeElement).toBe(divider);
    pointer(divider, 'pointermove', 380);
    expect(shown()).toBe(376);
    expect(divider.getAttribute('data-dragging')).toBe('true');
    expect(stored()).toBeUndefined();
    pointer(divider, 'pointermove', 900);
    expect(shown()).toBe(480);
    pointer(divider, 'pointerup', 900);
    expect(stored()?.width).toBe(480);
    expect(divider.hasAttribute('data-dragging')).toBe(false);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('drags a pane after the divider the other way', () => {
    const divider = render({ sizes: 'end', min: 320, max: 640, defaultWidth: 384 });
    capturing(divider);
    pointer(divider, 'pointerdown', 900);
    pointer(divider, 'pointermove', 860);
    expect(shown()).toBe(424);
    pointer(divider, 'pointerup', 860);
    expect(stored()?.width).toBe(424);
  });

  it('does not save a click, a right click or a cancelled or lost drag', () => {
    const divider = render();
    capturing(divider);
    pointer(divider, 'pointerdown', 340);
    pointer(divider, 'pointerup', 340);
    expect(stored()).toBeUndefined();

    const secondary = pointer(divider, 'pointerdown', 340, { button: 2 });
    expect(secondary.defaultPrevented).toBe(false);
    pointer(divider, 'pointermove', 400);
    expect(shown()).toBe(336);

    pointer(divider, 'pointerdown', 340);
    pointer(divider, 'pointermove', 400);
    expect(shown()).toBe(396);
    pointer(divider, 'pointercancel', 400);
    expect(shown()).toBe(336);
    pointer(divider, 'pointermove', 450);
    expect(shown()).toBe(336);

    pointer(divider, 'pointerdown', 340);
    pointer(divider, 'pointermove', 400);
    act(() => {
      divider.dispatchEvent(new Event('lostpointercapture', { bubbles: true }));
    });
    expect(shown()).toBe(336);
    pointer(divider, 'pointerup', 400);
    expect(stored()).toBeUndefined();
  });

  it('does not start a drag from a collapsed pane, but keeps focus', () => {
    useSettingsStore.getState().setPane(key, { width: 336, collapsed: true, lastExpanded: 336 });
    const divider = render({ collapsible: true });
    capturing(divider);
    pointer(divider, 'pointerdown', 20);
    expect(document.activeElement).toBe(divider);
    pointer(divider, 'pointermove', 200);
    expect(shown()).toBe(0);
    expect(divider.setPointerCapture).not.toHaveBeenCalled();
  });

  it('measures once on mount and disconnects its observer on unmount', () => {
    render();
    expect(disconnected).toBe(0);
    act(() => root.unmount());
    expect(disconnected).toBe(1);
    root = createRoot(host);
  });

  it('survives a storage that refuses writes: the size still changes on screen', () => {
    const divider = render();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    press(divider, 'ArrowRight');
    expect(shown()).toBe(344);
  });
});
