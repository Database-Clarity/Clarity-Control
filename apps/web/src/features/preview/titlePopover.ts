/**
 * The preview's term tooltips (`<title Name [key] />`) are popovers in the browser's top layer, so no
 * pane, scroller or `contain` ancestor can clip or cover them (the Popover API; where it does not
 * exist the element is simply `position: fixed`). They open on hover or focus, placed from the
 * anchor's own client rect: below it, flipped above when that leaves more room, shifted so the
 * whole box stays inside the viewport, and height-limited (scrolling) only when neither side fits.
 * Everything happens in one synchronous pass on open (one forced layout, no React render). Below the
 * anchor the box keeps POINTER_CLEARANCE so the pointer never covers it (keyboard focus opens it
 * in the same place); the anchor's close grace lets the pointer cross that gap into the box.
 */
import { isPhone, POINTER_CLEARANCE, viewportWidth } from '../../ui/anchorPlacement';

const EDGE = 8;
const GAP = 4;
let shown: HTMLElement | null = null;

type PopoverElement = HTMLElement & { showPopover?(): void; hidePopover?(): void };

export function openTitlePopover(
  anchor: HTMLElement,
  box: HTMLElement,
  pointer?: { x: number; y: number },
) {
  // One at a time: a box still in its close grace gives way to the next one.
  if (shown && shown !== box) closeTitlePopover(shown);
  shown = box;
  const popover = box as PopoverElement;
  if (typeof popover.showPopover === 'function') {
    if (!box.matches(':popover-open')) popover.showPopover();
  } else box.dataset.open = '';
  const rects = [...anchor.getClientRects()];
  const rect =
    (pointer &&
      rects.find(
        (r) =>
          pointer.x >= r.left &&
          pointer.x <= r.right &&
          pointer.y >= r.top &&
          pointer.y <= r.bottom,
      )) ||
    rects[0] ||
    anchor.getBoundingClientRect();
  // The width left of the reserved scrollbar gutter (the shared popover rule): a box over the
  // gutter is clipped there, so cap and clamp by it to keep the edge inset and the right border.
  const viewW = viewportWidth(),
    viewH = document.documentElement.clientHeight;
  box.style.maxWidth = `min(18.75rem, ${viewW - EDGE * 2}px)`;
  box.style.maxHeight = '';
  const width = box.offsetWidth;
  let height = box.offsetHeight;
  // Below keeps clear of the pointer (touch has none: a phone keeps the plain gap).
  const belowGap = isPhone() ? GAP : POINTER_CLEARANCE;
  const below = viewH - rect.bottom - belowGap - EDGE;
  const above = rect.top - GAP - EDGE;
  const placeAbove = height > below && above > below;
  const room = placeAbove ? above : below;
  if (height > room) {
    box.style.maxHeight = `${Math.max(room, 64)}px`;
    height = box.offsetHeight;
  }
  box.style.left = `${Math.max(EDGE, Math.min(rect.left, viewW - width - EDGE))}px`;
  box.style.top = `${placeAbove ? rect.top - GAP - height : rect.bottom + belowGap}px`;
}

export function closeTitlePopover(box: HTMLElement) {
  if (shown === box) shown = null;
  const popover = box as PopoverElement;
  if (typeof popover.hidePopover === 'function') {
    if (box.matches(':popover-open')) popover.hidePopover();
  } else delete box.dataset.open;
}
