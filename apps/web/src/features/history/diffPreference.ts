import { useSyncExternalStore } from 'react';

const key = 'clarity-diff-raw:v1';
const event = 'clarity-diff-view';
const subscribe = (notify: () => void) => {
  window.addEventListener(event, notify);
  window.addEventListener('storage', notify);
  return () => {
    window.removeEventListener(event, notify);
    window.removeEventListener('storage', notify);
  };
};
let fallback: boolean | undefined;
const read = () => {
  if (fallback !== undefined) return fallback;
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
};
export function useRawDiff() {
  const raw = useSyncExternalStore(subscribe, read, () => false);
  return [
    raw,
    (next: boolean) => {
      try {
        localStorage.setItem(key, String(next));
        fallback = undefined;
      } catch {
        // A quota failure can leave reads working; retain the choice in memory too.
        fallback = next;
      }
      window.dispatchEvent(new Event(event));
    },
  ] as const;
}
