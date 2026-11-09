import { langSchema } from '@clarity/core';

export type NavigateTo = (path: string, options: { replace: boolean; flushSync?: boolean }) => void;

/** A finder entry: an item under the group it is listed in ('' in a category without groups). */
export interface Entry {
  hash: number;
  group: string;
}
export const entryKey = (hash: number, group: string) => (group ? `${hash}:${group}` : `${hash}`);
export const keyOf = (entry: Entry) => entryKey(entry.hash, entry.group);

export function stepWithinCategory(
  current: number,
  direction: number,
  hashes: readonly number[],
): number | undefined {
  const index = hashes.indexOf(current);
  return index < 0 ? undefined : hashes[index + direction];
}

/**
 * The scope parameter: `all` (every group of the category), `all:<group>` (all, with a shared
 * entry opened under that group), or a group id. Written only when the item cannot imply it.
 */
const scopeParam = /^(all(?::[\w.-]+)?|[\w.-]+)$/;
export interface RouteScope {
  all: boolean;
  group?: string;
}
export function parseScope(value: string | null | undefined): RouteScope | undefined {
  if (!value || !scopeParam.test(value)) return undefined;
  if (value === 'all') return { all: true };
  if (value.startsWith('all:')) return { all: true, group: value.slice(4) };
  return { all: false, group: value };
}
/** The `?g=` value that restores `entry` in the scope, or undefined when the item implies it. */
export function scopeValue(
  entry: Entry,
  all: boolean,
  firstGroup: ReadonlyMap<number, string>,
): string | undefined {
  const implied = firstGroup.get(entry.hash) === entry.group;
  if (all) return implied ? 'all' : `all:${entry.group}`;
  return implied ? undefined : entry.group;
}
/** Where a route is: the scope and the group of its entry, from the route's own item and `g`. */
export function resolvePlace(
  route: RouteScope | undefined,
  hash: number,
  firstGroup: ReadonlyMap<number, string>,
  has: (hash: number, group: string) => boolean,
): { all: boolean; group: string } {
  const first = firstGroup.get(hash) ?? '';
  const named = route?.group !== undefined && has(hash, route.group) ? route.group : undefined;
  return route?.all ? { all: true, group: named ?? first } : { all: false, group: named ?? first };
}

/**
 * Tooltip route that keeps only a valid `?lang=` and `?g=`; `line`/`variant` highlights never
 * carry over. `scope` replaces the route's own `g` (null drops it).
 */
export function tooltipPath(hash: number, search: string, scope?: string | null): string {
  const params = new URLSearchParams(search);
  const requested = params.get('lang');
  const lang = requested === null ? undefined : langSchema.safeParse(requested).data;
  const g = scope === undefined ? params.get('g') : scope;
  const query = [lang && `lang=${lang}`, g && parseScope(g) && `g=${g}`].filter(Boolean).join('&');
  return `/t/${hash}${query ? `?${query}` : ''}`;
}

export interface StepTarget {
  /** Full current location (path + query), so history can restore it exactly. */
  from: string;
  to: { path: string; pathname: string; search: string };
  entry: Entry;
}

/**
 * Where a Previous/Next step goes from `current` within the scope's list, or undefined at its ends.
 * `link` builds the route of the entry stepped to (it knows the scope).
 */
export function stepTarget(
  location: { pathname: string; search: string },
  direction: number,
  list: readonly Entry[],
  indexes: ReadonlyMap<string, number>,
  current: Entry,
  link: (entry: Entry) => string,
): StepTarget | undefined {
  const index = indexes.get(keyOf(current));
  const entry = index === undefined ? undefined : list[index + direction];
  return entry && target(location, entry, link(entry));
}

export function target(
  location: { pathname: string; search: string },
  entry: Entry,
  path: string,
): StepTarget {
  const [pathname, search = ''] = path.split('?');
  return {
    from: `${location.pathname}${location.search}`,
    to: { path, pathname, search: search && `?${search}` },
    entry,
  };
}

export interface CategoryPosition {
  /** 1-based position of `current` in the scope, or 0 when it is not listed. */
  index: number;
  total: number;
  previous: Entry | undefined;
  next: Entry | undefined;
}

// Targets and counter for the Previous/Next buttons: same rule as `stepTarget`.
export function categoryPosition(
  current: Entry,
  list: readonly Entry[],
  indexes: ReadonlyMap<string, number>,
): CategoryPosition {
  const index = indexes.get(keyOf(current));
  return {
    index: index === undefined ? 0 : index + 1,
    total: list.length,
    previous: index === undefined ? undefined : list[index - 1],
    next: index === undefined ? undefined : list[index + 1],
  };
}

export function positionLabel(
  { index, total }: Pick<CategoryPosition, 'index' | 'total'>,
  name = 'category',
): string {
  return index ? `${index} of ${total}` : `${total} in ${name}`;
}

/**
 * What a wheel event with Shift steps: `entry` or `group`, and the direction. Plain Shift steps
 * entries and Alt+Shift steps groups; the device setting swaps them. A category without groups
 * steps entries either way.
 */
export function wheelStep(
  event: Pick<WheelEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'deltaX' | 'deltaY'>,
  options: { swap: boolean; grouped: boolean },
): { kind: 'entry' | 'group'; direction: number } | undefined {
  const direction = shiftScrollDirection(event);
  if (!direction) return undefined;
  const groups = options.grouped && event.altKey !== options.swap;
  return { kind: groups ? 'group' : 'entry', direction };
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
  frames?: {
    request(run: () => void): number;
    cancel(id: number): void;
    allow?(): boolean;
    end?(committed: boolean): void;
  },
) {
  let origin: string | undefined;
  let destination: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let permittedAt: number | undefined;
  let frame: number | undefined;
  let frameGeneration = 0;
  let landed: string | undefined;
  function cancel(committed = false) {
    frameGeneration++;
    if (frame !== undefined) frames?.cancel(frame);
    frame = undefined;
    clearTimeout(timer);
    origin = undefined;
    destination = undefined;
    landed = undefined;
    permittedAt = undefined;
    frames?.end?.(committed);
  }
  function land(landNavigate: NavigateTo) {
    if ((frames?.allow && !frames.allow()) || (guard && permittedAt !== guard.epoch())) {
      destination = landed;
      if (!destination) cancel();
      return;
    }
    if (destination) {
      landNavigate(destination, { replace: true, flushSync: true });
      landed = destination;
    }
  }
  function flush(landNavigate: NavigateTo = navigate) {
    frameGeneration++;
    if (frame !== undefined) frames?.cancel(frame);
    frame = undefined;
    land(landNavigate);
  }
  function commit() {
    // The two navigations restore the history shape of one gesture that was already allowed. If an
    // edit or a navigation happened since, that allowance is spent: leave history as it is.
    const valid = !guard || permittedAt === guard.epoch();
    const committed = Boolean(valid && origin && destination && origin !== destination);
    if (committed && origin && destination) {
      const [from, to] = [origin, destination];
      const run = () => {
        navigate(from, { replace: true });
        navigate(to, { replace: false });
      };
      if (guard) guard.authorized(run);
      else run();
    }
    cancel(committed);
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
      } else if (frame === undefined) {
        const generation = frameGeneration;
        frame = frames.request(() => {
          if (generation !== frameGeneration) return;
          frame = undefined;
          // The adapter publishes identity synchronously while the router can
          // coalesce document work. A newly opened overlay still owns input.
          land(navigate);
        });
      }
      clearTimeout(timer);
      timer = setTimeout(commit, 1000);
      return true;
    },
    commit,
    flush,
    cancel: () => cancel(),
  };
}
