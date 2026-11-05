import { langSchema } from '@clarity/core';

export type NavigateTo = (path: string, options: { replace: boolean; flushSync?: boolean }) => void;

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

/**
 * What the preview leave guard decides for stepping. Both are asked before any stepping state or
 * history changes.
 */
export interface SteppingGuard {
  /** May the current item be left for `to`? When not, the guard has shown its prompt. */
  allow(from: string, to: string): boolean;
  /** Changes whenever a change was made or cleared; a gesture older than that is no longer allowed. */
  epoch(): number;
  /** Runs the history navigations of an allowed gesture so the guard does not stop them. */
  authorized(run: () => void): void;
}

// Keep the pre-gesture route in history, not every intermediate wheel tick.
export function createStepping(
  navigate: NavigateTo,
  guard?: SteppingGuard,
  frames?: { request(run: () => void): number; cancel(id: number): void; allow?(): boolean },
) {
  let origin: string | undefined;
  let destination: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let permittedAt: number | undefined;
  let frame: number | undefined;
  let landed: string | undefined;
  function cancel() {
    if (frame !== undefined) frames?.cancel(frame);
    frame = undefined;
    clearTimeout(timer);
    origin = undefined;
    destination = undefined;
    landed = undefined;
    permittedAt = undefined;
  }
  function commit() {
    // The two navigations restore the history shape of one gesture that was already allowed. If an
    // edit or a navigation happened since, that allowance is spent: leave history as it is.
    const valid = !guard || permittedAt === guard.epoch();
    if (valid && origin && destination && origin !== destination) {
      const [from, to] = [origin, destination];
      const run = () => {
        navigate(from, { replace: true });
        navigate(to, { replace: false });
      };
      if (guard) guard.authorized(run);
      else run();
    }
    cancel();
  }
  return {
    get target() {
      return destination;
    },
    /** Returns false, having changed nothing, when the guard refuses or there is nothing to step to. */
    step(from: string, to: string): boolean {
      if (guard && !guard.allow(from, to)) {
        // A refused gesture ends here: no selection movement. What it already stepped through was
        // allowed, so history is finished as usual instead of losing the origin entry.
        commit();
        return false;
      }
      origin ??= from;
      destination = to;
      permittedAt = guard?.epoch();
      if (!frames) {
        navigate(to, { replace: true });
        landed = to;
      } else if (frame === undefined)
        frame = frames.request(() => {
          frame = undefined;
          if ((frames.allow && !frames.allow()) || (guard && permittedAt !== guard.epoch())) {
            // A dialog/list may have opened since the wheel packet was accepted. Keep
            // the last landed route and never move the workspace behind its new owner.
            destination = landed;
            if (!destination) cancel();
            return;
          }
          if (destination) {
            // The frame already chose the newest input. Commit the data-router
            // route in this frame too, rather than starting another transition
            // that can leave the visible editor one selection behind the URL.
            navigate(destination, { replace: true, flushSync: true });
            landed = destination;
          }
        });
      clearTimeout(timer);
      timer = setTimeout(commit, 1000);
      return true;
    },
    commit,
    cancel,
  };
}
