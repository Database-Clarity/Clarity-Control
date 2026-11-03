import { langSchema } from '@clarity/core';

export type NavigateTo = (path: string, options: { replace: boolean }) => void;

export function stepWithinCategory(
  current: number,
  direction: number,
  hashes: readonly number[],
): number | undefined {
  const index = hashes.indexOf(current);
  return index < 0 ? undefined : hashes[index + direction];
}

/** Tooltip route that keeps only a valid `?lang=`; `line`/`variant` highlights never carry over. */
export function tooltipPath(hash: number, search: string): string {
  const lang = langSchema.safeParse(new URLSearchParams(search).get('lang')).data;
  return `/t/${hash}${lang ? `?lang=${lang}` : ''}`;
}

export interface StepTarget {
  /** Full current location (path + query), so history can restore it exactly. */
  from: string;
  to: { path: string; pathname: string; search: string };
}

/** Where a Previous/Next step goes from `location`, or undefined at the category ends. */
export function stepTarget(
  location: { pathname: string; search: string },
  direction: number,
  hashes: readonly number[],
): StepTarget | undefined {
  const next = stepWithinCategory(Number(location.pathname.split('/')[2]), direction, hashes);
  if (next === undefined) return undefined;
  const path = tooltipPath(next, location.search);
  const [pathname, search = ''] = path.split('?');
  return {
    from: `${location.pathname}${location.search}`,
    to: { path, pathname, search: search && `?${search}` },
  };
}

export interface CategoryPosition {
  /** 1-based position of `current` in the category, or 0 when it is not listed. */
  index: number;
  total: number;
  previous: number | undefined;
  next: number | undefined;
}

// Targets and counter for the Previous/Next buttons: same rule as `stepWithinCategory`.
export function categoryPosition(current: number, hashes: readonly number[]): CategoryPosition {
  return {
    index: hashes.indexOf(current) + 1,
    total: hashes.length,
    previous: stepWithinCategory(current, -1, hashes),
    next: stepWithinCategory(current, 1, hashes),
  };
}

export function positionLabel({ index, total }: Pick<CategoryPosition, 'index' | 'total'>): string {
  return index ? `${index} of ${total}` : `${total} in category`;
}

export function shiftScrollDirection(
  event: Pick<WheelEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'deltaX' | 'deltaY'>,
): number {
  if (!event.shiftKey || event.ctrlKey || event.metaKey) return 0;
  return Math.sign(event.deltaY || event.deltaX);
}

type WheelInput = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'> & {
  // Non-standard, but preserves notch information lost to zoom / scroll-line scaling.
  wheelDeltaX?: number;
  wheelDeltaY?: number;
};

/** Discrete wheels bypass all smooth-stream state; there is deliberately no cooldown.
 * Without legacy notch data, pixel-only devices are necessarily heuristic: browsers
 * can emit identical events for a mouse and a trackpad. Large isolated deltas favor
 * immediate mouse navigation; small streams accumulate distance instead.
 */
export function createWheelStepper() {
  let accumulated = 0;
  let direction = 0;
  let last = -Infinity;
  let previous = 0;
  let decreases = 0;
  let momentum = false;
  return {
    /** Returns -1/1 when this event should step, else 0. */
    feed(event: WheelInput, now: number): number {
      const delta = event.deltaY || event.deltaX;
      if (!Number.isFinite(delta) || !delta) return 0;
      const sign = Math.sign(delta);
      const pixels = Math.abs(delta);
      // Shift on Windows may move the standard delta to X but leave legacy Y.
      const legacy = event.deltaY ? event.wheelDeltaY : event.wheelDeltaX || event.wheelDeltaY;
      const notch = event.deltaMode !== 0 || (!!legacy && legacy % 120 === 0);
      if (sign !== direction || now - last > 200) {
        accumulated = 0;
        previous = 0;
        decreases = 0;
        momentum = false;
      }
      direction = sign;
      last = now;
      if (notch) {
        accumulated = 0;
        previous = 0;
        decreases = 0;
        momentum = false;
        return sign;
      }
      decreases = pixels < previous ? decreases + 1 : 0;
      // A sustained decay is a momentum tail, not more distance to navigate.
      if (decreases >= 3) momentum = true;
      else if (pixels > previous * 1.5) momentum = false;
      previous = pixels;
      if (momentum) {
        accumulated = 0;
        return 0;
      }
      // Firefox pixel-mode wheels have no legacy fields; don't require 100 px.
      // Non-notch legacy values identify smooth input even at high velocity.
      if (!legacy && pixels >= 40) {
        accumulated = 0;
        return sign;
      }
      accumulated += pixels;
      if (accumulated < 100) return 0;
      accumulated %= 100;
      return sign;
    },
  };
}

// Keep the pre-gesture route in history, not every intermediate wheel tick.
export function createStepping(navigate: NavigateTo) {
  let origin: string | undefined;
  let destination: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    clearTimeout(timer);
    origin = undefined;
    destination = undefined;
  }
  function commit() {
    if (origin && destination && origin !== destination) {
      navigate(origin, { replace: true });
      navigate(destination, { replace: false });
    }
    cancel();
  }
  return {
    step(from: string, to: string) {
      origin ??= from;
      destination = to;
      navigate(to, { replace: true });
      clearTimeout(timer);
      timer = setTimeout(commit, 1000);
    },
    commit,
    cancel,
  };
}
