import { useMemo, useSyncExternalStore } from 'react';

/** The phone shell (header, sheets, stacked views). Matches the SCSS `mobile` breakpoint. */
export const phoneQuery = '(max-width: 700px)';
/** Where the touch size tokens apply (the SCSS `mobile-or-coarse` scope). */
export const touchQuery = '(max-width: 700px), (pointer: coarse)';
/** Compact desktop: the finder drops to a band and the left column starts collapsed. */
export const compactQuery = '(max-width: 1099px)';
/** Laptop widths where Translations folds into More. */
export const laptopQuery = '(max-width: 1280px)';
/**
 * Wide enough for Bungie drift as a header tab: measured 2026-11-10 on the production build (100%,
 * maintainer, the finder with its weapon select), Drift first fits at 1530px without shrinking the
 * finder's fields, swapping the lockup, or moving another tab; 30px more keeps room for a Drafts
 * count. Below it, Drift stays in More. (The compact band, 701-1099px, has room too, but
 * Translations is folded into More there, and Drift does not outrank it.)
 */
export const driftTabQuery = '(min-width: 1560px)';
/** Management as a tab too, after Drift (maintainers): first fits at 1630px, plus the same 30px. */
export const managementTabQuery = '(min-width: 1660px)';

const hasMatchMedia = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/**
 * The desktop layout classes follow the interface scale like a browser zoom: at 150 % a 1280px
 * window is the 853px window the compact layout is built for. The phone query stays physical (it
 * matches the stylesheets' own 700px media queries, which the scale limit in settings protects).
 */
const scaleAware = new Set([compactQuery, laptopQuery, driftTabQuery, managementTabQuery]);
export const uiScaleEvent = 'clarity-ui-scale';
function resolve(query: string): string {
  if (!scaleAware.has(query) || typeof document === 'undefined') return query;
  const applied = Number(document.documentElement.dataset.uiScale) || 100;
  return query.replace(
    /(\d+)px/,
    (_, px: string) => `${Math.round((Number(px) * applied) / 100)}px`,
  );
}

/** Live `matchMedia` result; false where it does not exist (server render, tests). */
export function useMedia(query: string): boolean {
  // One subscribe per query: a new function every render would make React unsubscribe and
  // resubscribe the listener each time the component renders.
  const source = useMemo(() => {
    let resolved = resolve(query);
    let list: MediaQueryList | undefined;
    const current = () => {
      if (!hasMatchMedia()) return undefined;
      return (list ??= window.matchMedia(resolved));
    };
    const subscribe = (notify: () => void) => {
      if (!current()) return () => {};
      list?.addEventListener?.('change', notify);
      // A new interface scale moves the thresholds: listen for the new query and re-read.
      const rescale = () => {
        const next = resolve(query);
        if (next === resolved) return;
        list?.removeEventListener?.('change', notify);
        resolved = next;
        list = window.matchMedia(resolved);
        list.addEventListener?.('change', notify);
        notify();
      };
      window.addEventListener(uiScaleEvent, rescale);
      return () => {
        list?.removeEventListener?.('change', notify);
        window.removeEventListener(uiScaleEvent, rescale);
      };
    };
    return { subscribe, snapshot: () => current()?.matches ?? false };
  }, [query]);
  return useSyncExternalStore(source.subscribe, source.snapshot, () => false);
}
