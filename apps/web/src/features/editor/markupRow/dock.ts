/**
 * The docked markup bar (a phone): fixed to the bottom of the visible page, over the text. Its
 * height is cached here by a ResizeObserver, so the caret's scroll margins and the Suggest menu's
 * bounds read a number instead of the layout. Zero while no bar is docked.
 *
 * The sticky chrome above the text (the phone header and the pane tabs) is cached the same way,
 * as the stuck bottom edge of the pane tab strip, so a paragraph kept in view is not hidden under it.
 */
import { setKeyboardBottomCover } from '../../../ui/useKeyboardInset';

let barHeight = 0;
let topChrome = 0;
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
  const read = () => {
    barHeight = bar.offsetHeight;
    measureTopChrome(bar.ownerDocument);
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(read);
  if (observer) observer.observe(bar);
  else read();
  return () => {
    observer?.disconnect();
    docks -= 1;
    if (!docks) barHeight = 0;
  };
}
