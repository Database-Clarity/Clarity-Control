import { useMemo, useSyncExternalStore } from 'react';

/** The phone shell (header, sheets, stacked views). Matches the SCSS `mobile` breakpoint. */
export const phoneQuery = '(max-width: 700px)';
/** Compact desktop: the finder drops to a band and the left column starts collapsed. */
export const compactQuery = '(max-width: 1099px)';
/** Laptop widths where Translations folds into More. */
export const laptopQuery = '(max-width: 1280px)';

const hasMatchMedia = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/**
 * The desktop layout classes follow the interface scale like a browser zoom: at 150 % a 1280px
 * window is the 853px window the compact layout is built for. The phone query stays physical (it
 * matches the stylesheets' own 700px media queries, which the scale limit in settings protects).
 */
const scaleAware = new Set([compactQuery, laptopQuery]);
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
  const subscribe = useMemo(
    () => (notify: () => void) => {
      if (!hasMatchMedia()) return () => {};
      let list = window.matchMedia(resolve(query));
      list.addEventListener?.('change', notify);
      // A new interface scale moves the thresholds: listen for the new query and re-read.
      const rescale = () => {
        list.removeEventListener?.('change', notify);
        list = window.matchMedia(resolve(query));
        list.addEventListener?.('change', notify);
        notify();
      };
      window.addEventListener(uiScaleEvent, rescale);
      return () => {
        list.removeEventListener?.('change', notify);
        window.removeEventListener(uiScaleEvent, rescale);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && window.matchMedia(resolve(query)).matches,
    () => false,
  );
}
