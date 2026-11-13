// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeStrip } from './NoticeStrip';
import { STATUS_FADE_MS, count, sortNotices, type ShellNotice } from './notices';

let host: HTMLDivElement;
let root: Root;
const render = (notices: ShellNotice[]) =>
  act(() => root.render(<NoticeStrip notices={notices} />));
const levels = () =>
  [...host.querySelectorAll<HTMLElement>('[data-level]')].map((n) => n.dataset.level);
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const alert: ShellNotice = { id: 'a', level: 'alert', text: 'Storage failed' };
const warning: ShellNotice = { id: 'w', level: 'warning', text: 'Differs' };
const status: ShellNotice = { id: 's', level: 'status', text: 'Saved 1 draft' };

describe('notice strip', () => {
  it('orders alert, warning, status whatever order they were built in', () => {
    render([status, warning, alert]);
    expect(levels()).toEqual(['alert', 'warning', 'status']);
    expect(sortNotices([status, alert]).map((n) => n.id)).toEqual(['a', 's']);
  });

  it('uses alert and status roles and renders nothing when empty', () => {
    render([]);
    expect(host.querySelector('[data-notice-strip]')).toBeNull();
    render([alert, status]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Storage failed');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('fades a status after six seconds, and calls onDismiss so a held message is cleared', () => {
    const onDismiss = vi.fn();
    render([{ ...status, onDismiss }]);
    advance(STATUS_FADE_MS - 1);
    expect(host.textContent).toContain('Saved 1 draft');
    advance(1);
    expect(host.textContent).not.toContain('Saved 1 draft');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pauses the fade while hovered or focused and restarts it afterwards', () => {
    render([{ ...status, actions: [{ label: 'Undo', onClick() {} }] }]);
    const notice = host.querySelector('[data-level="status"]')!;
    advance(5000);
    act(() => void notice.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => void notice.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    // React's onMouseEnter/Leave listen to mouseover/out.
    advance(5000);
    expect(host.textContent).toContain('Saved 1 draft');
    advance(1000);
    expect(host.textContent).not.toContain('Saved 1 draft');

    render([{ ...status, id: 's2', actions: [{ label: 'Undo', onClick() {} }] }]);
    const button = host.querySelector('button')!;
    act(() => button.focus());
    advance(20_000);
    expect(host.textContent).toContain('Saved 1 draft');
    act(() => button.blur());
    advance(STATUS_FADE_MS);
    expect(host.textContent).not.toContain('Saved 1 draft');
  });

  it('keeps alerts and warnings until dismissed, and brings a dismissed one back when it recurs', () => {
    render([alert, warning]);
    advance(60_000);
    expect(levels()).toEqual(['alert', 'warning']);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(levels()).toEqual(['warning']);
    // Still true on later renders: stays dismissed.
    render([alert, warning]);
    expect(levels()).toEqual(['warning']);
    // The condition resolves, then happens again: it shows again.
    render([warning]);
    render([alert, warning]);
    expect(levels()).toEqual(['alert', 'warning']);
  });

  it('dismisses a focused notice with Esc and hands focus back to where it came from', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    render([alert, warning]);
    act(() => outside.focus());
    const dismiss = host.querySelector<HTMLButtonElement>('[data-level="alert"] button')!;
    act(() => dismiss.focus());
    act(() => {
      dismiss.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(levels()).toEqual(['warning']);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps Esc from dismissing a prompt that needs an answer', () => {
    render([{ ...alert, actions: [{ label: 'Retry', onClick() {} }], dismissible: false }]);
    const retry = host.querySelector<HTMLButtonElement>('button')!;
    act(() => retry.focus());
    act(() => {
      retry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(levels()).toEqual(['alert']);
  });

  it('runs explicit actions and hides Dismiss on a prompt that needs an answer', () => {
    const retry = vi.fn();
    render([{ ...alert, actions: [{ label: 'Retry', onClick: retry }], dismissible: false }]);
    expect(host.querySelector('button[aria-label="Dismiss"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    // Retrying never dismisses by itself.
    expect(levels()).toEqual(['alert']);
  });

  it('shows a delayed status only once the condition has lasted', () => {
    render([{ id: 'p', level: 'status', text: 'Saving', delay: 800 }]);
    expect(host.textContent).toBe('');
    advance(799);
    expect(host.textContent).toBe('');
    advance(1);
    expect(host.textContent).toContain('Saving');
  });

  it('rises above the editor panels under it, past a stack, never under the header', async () => {
    // jsdom has no layout: boxes by element, the notice's moved up by the strip's --clear.
    const rect = (top: number, bottom: number, left: number, right: number) =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top }) as DOMRect;
    const panels: Record<string, [number, number]> = {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    box.mockImplementation(function (this: Element) {
      if (this.tagName === 'HEADER') return rect(0, 80, 0, 390);
      const panel = panels[this.id];
      if (panel) return rect(...panel, 0, 390);
      if (this.hasAttribute('data-level')) {
        const clear = parseFloat(this.parentElement!.style.getPropertyValue('--clear')) || 0;
        return rect(640 - clear, 700 - clear, 10, 380);
      }
      return rect(0, 0, 0, 0);
    });
    const header = document.createElement('header');
    const make = (id: string, attribute: string, edges: [number, number]) => {
      const element = document.createElement('section');
      element.id = id;
      element.setAttribute(attribute, '');
      panels[id] = edges;
      document.body.append(element);
      return element;
    };
    document.body.append(header);
    const bar = make('bar', 'data-editor-status', [650, 680]);
    const clear = () =>
      host.querySelector<HTMLElement>('[data-notice-strip]')!.style.getPropertyValue('--clear');
    try {
      render([status]);
      advance(20);
      // The status bar under the notice: just above it (650 - 4 = 646, from 700).
      expect(clear()).toBe('54px');
      // The Working diff opens on top of the bar (before it in the page, as in the editor):
      // above both (400 - 4 = 396, from 700).
      const diff = make('diff', 'data-editor-overlay', [400, 650]);
      await act(async () => void bar.before(diff));
      advance(20);
      expect(clear()).toBe('304px');
      // A panel nearly up to the header: past the bar only (60 tall would end above 84).
      panels.diff = [130, 650];
      await act(async () => void document.body.append(document.createElement('span')));
      window.dispatchEvent(new Event('resize'));
      advance(20);
      expect(clear()).toBe('54px');
      // Panels closed: back where it was.
      await act(async () => {
        diff.remove();
        bar.remove();
      });
      advance(20);
      expect(clear()).toBe('');
    } finally {
      box.mockRestore();
      header.remove();
      document.getElementById('diff')?.remove();
      document.getElementById('bar')?.remove();
    }
  });

  it('counts with the right plural', () => {
    expect(count(1, 'draft')).toBe('1 draft');
    expect(count(2, 'draft')).toBe('2 drafts');
  });
});
