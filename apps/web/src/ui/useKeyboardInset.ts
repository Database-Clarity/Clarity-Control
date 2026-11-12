import { useEffect } from 'react';
import { touchQuery } from './useMedia';

/**
 * The on-screen keyboard, for a phone.
 *
 * `useKeyboardInset` writes how far the keyboard covers the bottom of the layout viewport into
 * `--kb-inset` on the root element, so a bar fixed to the bottom sits on the keyboard. The page
 * keeps the browsers' default keyboard behaviour (no `interactive-widget=resizes-content`): the
 * keyboard shrinks only the visual viewport, on Android as on iOS, and the inset is what it hides.
 * `trackKeyboardInset` keeps it current on every page of a touch device, so sheets and lists sized
 * from `--app-h` (ui/global.scss) stay above the keyboard. One frame per viewport change, CSS
 * variables only (written when they change), no React state.
 *
 * Why not `resizes-content`: Gboard's space-bar cursor swipe and backspace swipe-select never worked
 * on this site in Vivaldi for Android while it was set (2026-11-12), though they did in Chrome and on
 * other sites in Vivaldi, which leave the default.
 *
 * `useKeyboardFollow` keeps the focused field in view when the keyboard opens (the visible area
 * shrinks): an input or text area scrolls clear of the keyboard and the docked bar; an element that
 * registered its own follower (the markup editor keeps the caret's paragraph in view) runs that.
 * Nothing runs while typing: only a change of the visible area schedules the frame. It listens only
 * while `active` (the docked bar is on screen).
 */

const insetVar = '--kb-inset';
/**
 * The keyboard's height (it shrinks only the visual viewport): room the docked editor adds below its
 * text, so the page can scroll its last lines above the keyboard, and what `--app-h` leaves out. It
 * does not change as the visual viewport pans or zooms, so neither changes the page's layout.
 */
const roomVar = '--kb-room';

function keyboard(win: Window): { inset: number; room: number } {
  const viewport = win.visualViewport;
  if (!viewport) return { inset: 0, room: 0 };
  // The layout viewport: the initial containing block where a browser reports the visual one.
  const layout = Math.max(win.innerHeight, win.document.documentElement.clientHeight);
  // The room is the keyboard alone: at the visible area's own zoom, so a pinch never changes it
  // (and never lays the page out again), while the inset follows the visible bottom edge.
  const room = Math.max(0, Math.round(layout - viewport.height * (viewport.scale || 1)));
  return { inset: Math.max(0, Math.round(layout - viewport.height - viewport.offsetTop)), room };
}

/** Starts writing the variables; the returned function stops and clears them. */
function writeInset(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
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
}

// One writer however many holders (the site-wide tracker, the docked bar): the last release stops it.
let holders = 0;
let stopWriting: (() => void) | undefined;
function holdInset(): () => void {
  if (holders++ === 0) stopWriting = writeInset();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holders === 0) {
      stopWriting?.();
      stopWriting = undefined;
    }
  };
}

export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    if (!active || !window.visualViewport) return;
    return holdInset();
  }, [active]);
}

/** Site-wide, from startup: holds the inset while the device is a touch one (`touchQuery`). */
export function trackKeyboardInset(win: Window = window): () => void {
  if (!win.visualViewport || typeof win.matchMedia !== 'function') return () => {};
  const touch = win.matchMedia(touchQuery);
  let release: (() => void) | undefined;
  const update = () => {
    if (touch.matches && !release) release = holdInset();
    else if (!touch.matches && release) {
      release();
      release = undefined;
    }
  };
  update();
  touch.addEventListener?.('change', update);
  return () => {
    touch.removeEventListener?.('change', update);
    release?.();
    release = undefined;
  };
}

/**
 * How far bottom-anchored surfaces lift for the keyboard (`--kb-lift`, ui/global.scss): the inset
 * on a touch device, 0 on iOS and elsewhere. For layout code that reads the window's height.
 */
export function keyboardLift(win: Window = window): number {
  const root = win.document.documentElement;
  const lift = parseFloat(win.getComputedStyle(root).getPropertyValue('--kb-lift'));
  return Number.isFinite(lift) ? lift : 0;
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

export function useKeyboardFollow(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport || typeof window.matchMedia !== 'function') return;
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
  }, [active]);
}
