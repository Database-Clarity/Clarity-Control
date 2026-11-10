/**
 * The docked markup bar (a phone): fixed to the bottom of the visible page, over the text. Its
 * height is cached here by a ResizeObserver, so the caret's scroll margins and the Suggest menu's
 * bounds read a number instead of the layout. Zero while no bar is docked.
 *
 * The sticky chrome above the text (the phone header and the pane tabs) is cached the same way,
 * as the stuck bottom edge of the pane tab strip, so a paragraph kept in view is not hidden under it.
 * So is the editor's status bar: how far it reaches below the end of the text, which the caret's
 * margin clears on the last line. All of them are read in the ResizeObserver, never while typing.
 */
import { setKeyboardBottomCover } from '../../../ui/useKeyboardInset';

let barHeight = 0;
let topChrome = 0;
let statusClear = 0;
let docks = 0;
setKeyboardBottomCover(() => barHeight);

/** The docked bar's height in px (0 when none is docked). */
export function dockedBarHeight(): number {
  return barHeight;
}

/** The sticky chrome over the top of the page while a bar is docked (0 when none is docked). */
export function dockedTopChrome(): number {
  return docks ? topChrome : 0;
}

/** How far the editor's status bar reaches below the end of its text (0 when none is docked). */
export function dockedStatusClear(): number {
  return docks ? statusClear : 0;
}

/** Measures the sticky chrome: the pane tab strip stuck under the header. Not on the typing path. */
export function measureTopChrome(owner: Document = document): void {
  const strip = owner.querySelector<HTMLElement>('[role="tablist"][aria-label="Tooltip panels"]');
  if (!strip || !strip.offsetHeight) {
    const header = owner.querySelector<HTMLElement>('header');
    topChrome = header && getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0;
    return;
  }
  const top = parseFloat(getComputedStyle(strip).top);
  topChrome = (Number.isFinite(top) ? top : 0) + strip.offsetHeight;
}

/** Follows a docked bar's height until the returned function is called. */
export function observeDock(bar: HTMLElement): () => void {
  docks += 1;
  const root = bar.ownerDocument.documentElement;
  const editor = bar.closest('[data-editor-root]');
  const status = editor?.querySelector<HTMLElement>('[data-editor-status]');
  const read = () => {
    barHeight = bar.offsetHeight;
    // The room the editor leaves under itself: the bar as drawn (a Large bar is taller than --bar).
    root.style.setProperty('--dock-h', `${barHeight}px`);
    measureTopChrome(bar.ownerDocument);
    // The editor's text mounts after the bar (its view is made in the editor's own effect).
    const content = editor?.querySelector<HTMLElement>('.cm-content');
    if (status && content) {
      const end =
        content.getBoundingClientRect().bottom -
        parseFloat(getComputedStyle(content).paddingBottom);
      statusClear = Math.max(0, Math.round(status.getBoundingClientRect().bottom - end));
    }
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(read);
  if (observer) {
    observer.observe(bar);
    if (status) observer.observe(status);
  } else read();
  return () => {
    observer?.disconnect();
    docks -= 1;
    if (docks) return;
    barHeight = 0;
    root.style.removeProperty('--dock-h');
  };
}
