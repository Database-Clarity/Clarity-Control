import { useEffect, useRef, useState } from 'react';
import { usePreviewReviewStore, type ReviewEntry } from '../../stores/previewReview';

interface PendingRender {
  entry: ReviewEntry;
  token: ReviewEntry;
  timer: ReturnType<typeof setTimeout>;
}

function sameRevision(previous: ReviewEntry, current: ReviewEntry): boolean {
  return (
    previous === current ||
    (previous.canonical === current.canonical &&
      previous.dirty === current.dirty &&
      current.reviewed > previous.reviewed)
  );
}

/**
 * The guard/save ledger stays immediate. The status warning gives revisions scheduled for a
 * visible render their render opportunity first. Other variants and hidden previews warn now.
 * Each pending revision gets its own 250 ms watchdog, unaffected by unrelated ledger updates
 * or acknowledgements of older revisions. Clearing or replacing a revision cancels its timer.
 */
export function usePreviewWarnings() {
  const entries = usePreviewReviewStore((state) => state.entries);
  const pending = useRef(new Map<number, PendingRender>());
  const [expired, setExpired] = useState<Record<number, ReviewEntry>>({});
  useEffect(() => {
    const timers = pending.current;
    for (const [variant, render] of timers) {
      const entry = entries[variant];
      if (!entry || entry.dirty <= entry.reviewed || !sameRevision(render.entry, entry)) {
        clearTimeout(render.timer);
        timers.delete(variant);
      } else render.entry = entry;
    }
    for (const [key, entry] of Object.entries(entries)) {
      const variant = Number(key);
      if (entry.dirty <= entry.reviewed || timers.has(variant)) continue;
      const token = entry;
      const timer = setTimeout(() => {
        if (timers.get(variant)?.token === token)
          setExpired((previous) => ({ ...previous, [variant]: token }));
      }, 250);
      timers.set(variant, { entry, token, timer });
    }
  }, [entries]);
  useEffect(() => {
    const timers = pending.current;
    return () => {
      for (const render of timers.values()) clearTimeout(render.timer);
      timers.clear();
    };
  }, []);
  return (canonical: number, scheduled: readonly number[], visible: boolean) =>
    Object.entries(entries).filter(([key, entry]) => {
      if (entry.canonical !== canonical || entry.dirty <= entry.reviewed) return false;
      const variant = Number(key);
      const render = pending.current.get(variant);
      const timedOut =
        render && sameRevision(render.entry, entry) && expired[variant] === render.token;
      return !visible || !scheduled.includes(variant) || timedOut;
    }).length;
}
