import { scaledPx } from './scale';
import { phoneQuery } from './useMedia';

/**
 * Where a popover goes next to the control that opened it, on every screen size: below the
 * trigger, or above it when the content does not fit below and there is more room above; never
 * outside the visible area (on a phone: above the keyboard and the docked markup bar). The chosen
 * side's room is the popover's max-height, so a long popover scrolls inside instead of leaving
 * the screen. A popover above the trigger is held by its bottom edge, so content that grows while
 * it is open (a confirm in place of a row) grows away from the trigger.
 */

export interface TriggerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The area a popover may use, in layout-viewport coordinates (what `position: fixed` uses). */
export interface PlacementArea {
  /** The first usable y. */
  top: number;
  /** The last usable y. */
  bottom: number;
  /** The usable width, from x = 0. */
  width: number;
  /** The layout viewport's height (`bottom` in CSS counts from it). */
  layoutHeight: number;
  /** The gap kept from the left and right edges. */
  edge: number;
}

export interface Placement {
  side: 'below' | 'above';
  left: number;
  width: number;
  maxHeight: number;
  /** CSS `top` (below) or `bottom` (above); the other one is `auto`. */
  top: number | 'auto';
  bottom: number | 'auto';
}

export function placeAnchored({
  trigger,
  area,
  width,
  height = 0,
  gap = 4,
  align = 'end',
}: {
  trigger: TriggerRect;
  area: PlacementArea;
  /** The popover's own width; capped at the area's width less both edges. */
  width: number;
  /** The content's natural height (0 when unknown: below wins unless above has more room). */
  height?: number;
  /** Space between the trigger and the popover. */
  gap?: number;
  /** Which trigger edge the popover lines up with (start: left edges, end: right edges). */
  align?: 'start' | 'end';
}): Placement {
  const { edge } = area;
  const fit = Math.max(0, Math.min(width, area.width - edge * 2));
  const wanted = align === 'end' ? trigger.right - fit : trigger.left;
  const left = Math.max(edge, Math.min(wanted, area.width - fit - edge));
  const below = area.bottom - (trigger.bottom + gap);
  const above = trigger.top - gap - area.top;
  if (height <= below || below >= above) {
    return {
      side: 'below',
      left,
      width: fit,
      maxHeight: Math.max(0, below),
      top: trigger.bottom + gap,
      bottom: 'auto',
    };
  }
  return {
    side: 'above',
    left,
    width: fit,
    maxHeight: Math.max(0, above),
    top: 'auto',
    bottom: area.layoutHeight - (trigger.top - gap),
  };
}

/** Whether popovers use the phone rules (the page edge inset, the full page width). */
export function isPhone(win: Window = window): boolean {
  return win.matchMedia?.(phoneQuery).matches ?? false;
}

/**
 * The visible area now: the visual viewport (the keyboard shrinks it), less the docked markup
 * bar (`--dock-h`, set while it is on screen) and the edge gap. On a phone the edge is the page's
 * side inset (`--page-x`, 0.5rem); elsewhere 8px. `clearTop` raises the top limit (a popover
 * that must not cover the sticky header), used as given, with no edge gap.
 */
export function visibleArea(win: Window = window, clearTop?: number): PlacementArea {
  const phone = isPhone(win);
  const edge = phone ? scaledPx(8) : 8;
  const viewport = win.visualViewport;
  const layoutHeight = win.innerHeight;
  const visibleTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
  const visibleBottom = viewport
    ? Math.min(layoutHeight, viewport.offsetTop + viewport.height)
    : layoutHeight;
  const dock = phone
    ? parseFloat(win.getComputedStyle(win.document.documentElement).getPropertyValue('--dock-h'))
    : 0;
  return {
    top: clearTop === undefined ? visibleTop + edge : Math.max(visibleTop, clearTop),
    bottom: visibleBottom - (Number.isFinite(dock) ? dock : 0) - edge,
    width: win.innerWidth,
    layoutHeight,
    edge,
  };
}

/**
 * The natural height of a surface whose `scroller` child holds the content: the surface as drawn,
 * less the scroller's visible part, plus everything the scroller holds.
 */
export function naturalHeight(surface: HTMLElement, scroller: HTMLElement | null): number {
  if (!scroller) return surface.offsetHeight;
  return surface.offsetHeight - scroller.clientHeight + scroller.scrollHeight;
}

/** Writes a placement onto a fixed element (direct style writes: no React render). */
export function applyPlacement(element: HTMLElement, placement: Placement): void {
  const px = (value: number | 'auto') => (value === 'auto' ? 'auto' : `${value}px`);
  Object.assign(element.style, {
    left: `${placement.left}px`,
    width: `${placement.width}px`,
    maxHeight: `${placement.maxHeight}px`,
    top: px(placement.top),
    bottom: px(placement.bottom),
  });
}

/**
 * Runs `place` once a frame at most while the trigger can move or the visible area changes:
 * window resize, the visual viewport (the keyboard, pinch), and any scroll outside `surface`.
 */
export function followPlacement(surface: () => Element | null, place: () => void): () => void {
  let frame = 0;
  const schedule = (event?: Event) => {
    const element = surface();
    if (event?.target instanceof Node && element?.contains(event.target)) return;
    if (!frame) frame = requestAnimationFrame(run);
  };
  const run = () => {
    frame = 0;
    place();
  };
  const viewport = window.visualViewport;
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  return () => {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
