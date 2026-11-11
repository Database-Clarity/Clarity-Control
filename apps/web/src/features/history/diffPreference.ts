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
let fallback = false;
const read = () => {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return fallback;
  }
};
export function useRawDiff() {
  const raw = useSyncExternalStore(subscribe, read, () => false);
  return [
    raw,
    (next: boolean) => {
      fallback = next;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* Private storage can be unavailable. */
      }
      window.dispatchEvent(new Event(event));
    },
  ] as const;
}
