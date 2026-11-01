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
