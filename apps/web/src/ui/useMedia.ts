import { useSyncExternalStore } from 'react';

/** The phone shell (header, sheets, stacked views). Matches the SCSS `mobile` breakpoint. */
export const phoneQuery = '(max-width: 700px)';
/** Compact desktop: the finder drops to a band and the left column starts collapsed. */
export const compactQuery = '(max-width: 1099px)';
/** Laptop widths where Translations folds into More. */
export const laptopQuery = '(max-width: 1280px)';

/** Live `matchMedia` result; false where it does not exist (server render, tests). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.('change', notify);
      return () => list.removeEventListener?.('change', notify);
    },
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false,
  );
}
