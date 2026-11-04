import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { useSettingsStore, type PaneState } from '../stores/settings';
import { scaledPx } from './scale';

/** Width of the grid track a divider occupies; the line sits in its middle. */
export const DIVIDER_TRACK = 16;
export const ARROW_STEP = 8;
export const SHIFT_ARROW_STEP = 32;

export interface PaneDividerOptions {
  /** Where the size is saved on this device: `<page type>:<pair>`, e.g. `editor:left`. */
  storeKey: string;
  /** The pane this divider sizes: the one before it (`start`, a left column) or after it (`end`, a right pane). */
  sizes: 'start' | 'end';
  /** Pane width limits in CSS pixels. */
  min: number;
  max: number;
  /** Width when nothing is saved. Receives the measured container width (0 before the first measurement). */
  defaultWidth: number | ((containerWidth: number) => number);
  /** Smallest width the other (flexible) pane keeps; a viewport that is too small clamps the sized pane instead. */
  reserve?: number;
  /** The pane may be collapsed to nothing. Only an explicit action collapses it, never a drag. */
  collapsible?: boolean;
  /** Collapsed until the user expands it, when nothing is saved (compact windows). */
  defaultCollapsed?: boolean;
  /** false (phone): the size lives in memory only and nothing is read from or written to the device. */
  persist?: boolean;
  /** Retain the last measurement while the containing workspace is temporarily hidden. */
  paused?: boolean;
}

export interface PaneDividerHandle {
  /** Attach to the element whose width the pair shares. */
  containerRef: RefObject<HTMLDivElement>;
  /** Pane width in pixels as displayed: clamped to the viewport, 0 while collapsed. */
  width: number;
  collapsed: boolean;
  dragging: boolean;
  containerWidth: number;
  /** The size the user chose, if any; a viewport clamp never changes it. */
  saved: PaneState | undefined;
  /** Sets the intended width (and expands). Used by compatibility adapters; the divider itself calls it too. */
  setWidth(width: number): void;
  collapse(): void;
  expand(): void;
  reset(): void;
  /** Spread onto `<PaneDivider />`. */
  divider: {
    value: number;
    min: number;
    max: number;
    collapsed: boolean;
    collapsible: boolean;
    dragging: boolean;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
    onPointerDown(event: PointerEvent<HTMLElement>): void;
    onPointerMove(event: PointerEvent<HTMLElement>): void;
    onPointerUp(event: PointerEvent<HTMLElement>): void;
    onPointerCancel(event: PointerEvent<HTMLElement>): void;
    onLostPointerCapture(event: PointerEvent<HTMLElement>): void;
    onDoubleClick(): void;
  };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * The interface scale as a factor (1 at 100 %): the root font size over 16. Pane limits, defaults and
 * saved sizes are design pixels, so a pane keeps its share of the window at every scale.
 */
function useScaleFactor(): number {
  const [factor, setFactor] = useState(() => scaledPx(1));
  useEffect(() => {
    const update = () => setFactor(scaledPx(1));
    update();
    window.addEventListener('clarity-ui-scale', update);
    return () => window.removeEventListener('clarity-ui-scale', update);
  }, []);
  return factor;
}

/**
 * One behaviour for every resizable pair. The saved size is the size the user chose; what is shown is
 * that size clamped to the limits and the space available, so a narrow window never overwrites it.
 */
export function usePaneDivider(options: PaneDividerOptions): PaneDividerHandle {
  const { storeKey, sizes, defaultWidth, collapsible = false, defaultCollapsed = false } = options;
  const k = useScaleFactor();
  // Design pixels -> CSS pixels at the current interface scale.
  const min = options.min * k;
  const max = options.max * k;
  const reserve = (options.reserve ?? 0) * k;
  const track = DIVIDER_TRACK * k;
  const persist = options.persist ?? true;
  const paused = options.paused ?? false;
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const savedPane = useSettingsStore((state) => state.device.panes[storeKey]);
  const [memory, setMemory] = useState<PaneState | undefined>();
  const saved = persist ? savedPane : memory;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  // Measured before the first paint, so a saved size never shows unclamped for a frame.
  useLayoutEffect(() => {
    if (paused) return;
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [paused]);

  const fallback =
    (typeof defaultWidth === 'function' ? defaultWidth(containerWidth) : defaultWidth) * k;
  const space = containerWidth > 0 ? Math.max(0, containerWidth - reserve - track) : Infinity;
  const upper = Math.min(max, space);
  const lower = Math.min(min, upper);
  const collapsed = collapsible && (saved ? Boolean(saved.collapsed) : defaultCollapsed);
  const intended = dragWidth ?? (saved ? saved.width * k : fallback);
  const width = collapsed ? 0 : clamp(intended, lower, upper);

  const write = useCallback(
    (next: PaneState | null) => {
      if (persist) useSettingsStore.getState().setPane(storeKey, next);
      else setMemory(next ?? undefined);
    },
    [persist, storeKey],
  );
  // Latest values for handlers that outlive a render (pointer events, effects).
  const latest = useRef({ width, lower, upper, collapsed, fallback, saved });
  latest.current = { width, lower, upper, collapsed, fallback, saved };
  const factor = useRef(k);
  factor.current = k;

  const setWidth = useCallback(
    (next: number) => {
      const { lower: low, upper: high, saved: current } = latest.current;
      // Saved in design pixels, so the size survives a change of interface scale.
      const value = Math.round(clamp(next, low, high) / factor.current);
      if (current && !current.collapsed && current.width === value) return;
      write({ width: value, collapsed: false });
    },
    [write],
  );
  const collapse = useCallback(() => {
    const { width: shown, collapsed: already, saved: current, fallback: base } = latest.current;
    if (!collapsible || already) return;
    const restore = Math.round(
      (shown || (current?.width ?? 0) * factor.current || base) / factor.current,
    );
    write({ width: restore, collapsed: true, lastExpanded: restore });
  }, [collapsible, write]);
  const expand = useCallback(() => {
    const { saved: current, fallback: base } = latest.current;
    if (!latest.current.collapsed) return;
    write({
      width: Math.round(current?.lastExpanded ?? current?.width ?? base / factor.current),
      collapsed: false,
    });
  }, [write]);
  const reset = useCallback(() => {
    setDragWidth(null);
    write(null);
  }, [write]);

  const grows = sizes === 'start' ? 'ArrowRight' : 'ArrowLeft';
  const shrinks = sizes === 'start' ? 'ArrowLeft' : 'ArrowRight';

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = (event.shiftKey ? SHIFT_ARROW_STEP : ARROW_STEP) * k;
    const { width: shown, lower: low, upper: high } = latest.current;
    if (event.key === grows || event.key === shrinks) {
      event.preventDefault();
      if (collapsed) {
        if (event.key === grows) expand();
        return;
      }
      setWidth(shown + (event.key === grows ? step : -step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (collapsible) collapse();
      else setWidth(low);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (collapsed) expand();
      else setWidth(high);
    } else if (event.key === 'Enter' && collapsible) {
      event.preventDefault();
      if (collapsed) expand();
      else collapse();
    }
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    // Resizing must not start a text selection, and the handle keeps focus for the keyboard.
    event.preventDefault();
    event.currentTarget.focus();
    if (latest.current.collapsed) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      width,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientX - current.startX;
    const { lower: low, upper: high } = latest.current;
    current.width = clamp(current.startWidth + (sizes === 'start' ? delta : -delta), low, high);
    setDragWidth(current.width);
  }
  function release(event: PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onPointerUp(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    release(event);
    // Only a real move is saved; a click or double click never rewrites the stored size.
    if (Math.round(current.width) !== Math.round(current.startWidth)) setWidth(current.width);
    setDragWidth(null);
  }
  function onPointerCancel(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    release(event);
    setDragWidth(null);
  }
  function onLostPointerCapture() {
    // Capture ended without pointerup (element removed, another capture): drop the drag unsaved.
    if (!drag.current) return;
    drag.current = null;
    setDragWidth(null);
  }

  // A divider that unmounts mid-drag leaves nothing behind: handlers are element-bound.
  useEffect(
    () => () => {
      drag.current = null;
    },
    [],
  );

  return {
    containerRef,
    width,
    collapsed,
    dragging: dragWidth !== null,
    containerWidth,
    saved,
    setWidth,
    collapse,
    expand,
    reset,
    divider: {
      value: width,
      min: collapsible ? 0 : lower,
      max: upper === Infinity ? max : upper,
      collapsed,
      collapsible,
      dragging: dragWidth !== null,
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onDoubleClick: reset,
    },
  };
}
