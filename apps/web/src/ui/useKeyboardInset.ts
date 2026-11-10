import { useEffect } from 'react';
import { touchQuery } from './useMedia';

/**
 * The on-screen keyboard, for a phone.
 *
 * `useKeyboardInset` writes how far the keyboard covers the bottom of the layout viewport into
 * `--kb-inset` on the root element, so a bar fixed to the bottom sits on the keyboard. Chrome for
 * Android resizes the page itself (`interactive-widget=resizes-content`), so there the inset stays
 * 0; iOS Safari only shrinks the visual viewport, and the inset is what it hides. One frame per
 * viewport change, CSS variables only (written when they change), no React state.
 *
 * `useKeyboardFollow` keeps the focused field in view when the keyboard opens (the visible area
 * shrinks): an input or text area scrolls clear of the keyboard and the docked bar; an element that
 * registered its own follower (the markup editor keeps the caret's paragraph in view) runs that.
 * Nothing runs while typing: only a change of the visible area schedules the frame.
 */

const insetVar = '--kb-inset';
/**
 * The keyboard's height where only the visual viewport shrinks (iOS): room the docked editor adds
 * below its text, so the page can scroll its last lines above the keyboard. It does not change as
 * the visual viewport pans, so scrolling never changes the page's length.
 */
const roomVar = '--kb-room';

function keyboard(win: Window): { inset: number; room: number } {
  const viewport = win.visualViewport;
  if (!viewport) return { inset: 0, room: 0 };
  const room = Math.max(0, Math.round(win.innerHeight - viewport.height));
  return { inset: Math.max(0, Math.round(room - viewport.offsetTop)), room };
}

export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const root = document.documentElement;
    let frame = 0;
    let written = { inset: -1, room: -1 };
    const write = () => {
      frame = 0;
      const next = keyboard(window);
      if (next.inset !== written.inset) root.style.setProperty(insetVar, `${next.inset}px`);
      if (next.room !== written.room) root.style.setProperty(roomVar, `${next.room}px`);
      written = next;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(write);
    };
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    schedule();
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty(insetVar);
      root.style.removeProperty(roomVar);
    };
  }, [active]);
}

/** Keeps its own content in view; called once per keyboard opening while it holds focus. */
export type KeyboardFollower = () => void;
const followers = new Map<Element, KeyboardFollower>();

/** Registers `follow` for focus inside `element` until the returned function is called. */
export function followKeyboard(element: Element, follow: KeyboardFollower): () => void {
  followers.set(element, follow);
  return () => {
    if (followers.get(element) === follow) followers.delete(element);
  };
}

/** Extra room kept below a field, over what covers the bottom (the docked bar). */
let bottomCover: () => number = () => 0;
/** The docked markup bar reports its height here, so plain fields keep clear of it as well. */
export function setKeyboardBottomCover(read: () => number): void {
  bottomCover = read;
}

const gap = 8;

function isTextField(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(element.type);
}

/** The visible band of the page, in client coordinates: above the keyboard and the docked bar. */
export function visibleBand(win: Window = window): { top: number; bottom: number } {
  const viewport = win.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const bottom = top + (viewport?.height ?? win.innerHeight);
  return { top, bottom: bottom - bottomCover() };
}

/** Scrolls a plain field (input, text area) into the visible band, if any of it is outside. */
function followField(field: HTMLElement) {
  const band = visibleBand();
  let rect = field.getBoundingClientRect();
  if (rect.top >= band.top + gap && rect.bottom <= band.bottom - gap) return;
  // Nested scrollers (a sheet, a pane) first; the page itself is then nudged by what is left,
  // because a browser that only shrinks the visual viewport (iOS) counts the hidden part as seen.
  field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  rect = field.getBoundingClientRect();
  const top = band.top + gap;
  const bottom = band.bottom - gap;
  // Its bottom above the keyboard; a field taller than the band keeps its top in view instead.
  const by =
    rect.top < top
      ? rect.top - top
      : rect.bottom > bottom
        ? Math.min(rect.bottom - bottom, rect.top - top)
        : 0;
  if (by) window.scrollBy(0, by);
}

export function useKeyboardFollow(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || typeof window.matchMedia !== 'function') return;
    const touch = window.matchMedia(touchQuery);
    let frame = 0;
    let height = viewport.height;
    const run = () => {
      frame = 0;
      const active = document.activeElement;
      if (!active || active === document.body) return;
      for (const [element, follow] of followers) if (element.contains(active)) return follow();
      if (isTextField(active)) followField(active);
    };
    const resize = () => {
      const next = viewport.height;
      const shrank = next < height - 1;
      height = next;
      // Only a shrinking visible area (the keyboard opening, or growing taller) moves anything.
      if (!shrank || !touch.matches || frame) return;
      frame = requestAnimationFrame(run);
    };
    viewport.addEventListener('resize', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
