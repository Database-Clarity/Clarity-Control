/**
 * The preview's term tooltips (`<title Name [key] />`) are popovers in the browser's top layer, so no
 * pane, scroller or `contain` ancestor can clip or cover them (the Popover API; where it does not
 * exist the element is simply `position: fixed`). They open on hover or focus, placed from the
 * anchor's own client rect: below-right of it (below-left at the right edge), flipped above when
 * that leaves more room, kept inside the viewport, and height-limited (scrolling) only when neither
 * side fits.
 * Everything happens in one synchronous pass on open (one forced layout, no React render). Below the
 * anchor the box keeps POINTER_CLEARANCE so the pointer never covers it (keyboard focus opens it
 * in the same place); the anchor's close grace lets the pointer cross that gap into the box.
 */
import { POINTER_CLEARANCE, viewportWidth } from '../../ui/anchorPlacement';

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
  // Below keeps clear of the pointer (or the finger that tapped the anchor).
  const belowGap = POINTER_CLEARANCE;
  const below = viewH - rect.bottom - belowGap - EDGE;
  const above = rect.top - GAP - EDGE;
  const placeAbove = height > below && above > below;
  const room = placeAbove ? above : below;
  if (height > room) {
    box.style.maxHeight = `${Math.max(room, 64)}px`;
    height = box.offsetHeight;
  }
  // Below-right of the anchor, or below-left when the right has no room, so the box never covers
  // the anchor's own column: the pointer can move straight on to the next row's marker or term
  // while this box is still in its close grace. Clamped inside the viewport when neither fits.
  const left =
    rect.right + width <= viewW - EDGE
      ? rect.right
      : rect.left - width >= EDGE
        ? rect.left - width
        : Math.max(EDGE, Math.min(rect.left, viewW - width - EDGE));
  box.style.left = `${left}px`;
  // A plain box (nothing to click, nothing to scroll) never takes the pointer: one still in its
  // close grace over another anchor (the next row's finder marker) lets that anchor's hover through.
  const interactive = box.scrollHeight > box.clientHeight + 1 || !!box.querySelector('a[href]');
  box.style.pointerEvents = interactive ? '' : 'none';
  box.style.top = `${placeAbove ? rect.top - GAP - height : rect.bottom + belowGap}px`;
}

export function closeTitlePopover(box: HTMLElement) {
  if (shown === box) shown = null;
  const popover = box as PopoverElement;
  if (typeof popover.hidePopover === 'function') {
    if (box.matches(':popover-open')) popover.hidePopover();
  } else delete box.dataset.open;
}
