import { useEffect, useRef, useState } from 'react';
import { usePreviewReviewStore, type ReviewEntry } from '../../stores/previewReview';

interface PendingRender {
  entry: ReviewEntry;
  token: ReviewEntry;
  timer: ReturnType<typeof setTimeout>;
}

function sameRevision(previous: ReviewEntry, current: ReviewEntry): boolean {
  return previous.canonical === current.canonical && previous.dirty === current.dirty;
}

/**
 * The guard/save ledger stays immediate. The status warning gives revisions scheduled for a
 * visible render their render opportunity first. Other variants and hidden previews warn now.
 * Each pending revision gets its own 250 ms watchdog, unaffected by unrelated ledger updates
 * or acknowledgements of older revisions. Clearing or replacing a revision cancels its timer.
 */
export function usePreviewWarnings() {
  const entries = usePreviewReviewStore((state) => state.entries);
  const scope = usePreviewReviewStore((state) => state.scope);
  const pending = useRef({ scope, timers: new Map<number, PendingRender>() });
  const [expired, setExpired] = useState<Record<number, ReviewEntry>>({});
  useEffect(() => {
    const tracked = pending.current;
    const timers = tracked.timers;
    const clear = () => {
      for (const render of timers.values()) clearTimeout(render.timer);
      timers.clear();
    };
    // Observe every ledger transition, including a clear and re-edit batched into one React
    // render. Equivalent entry copies preserve deadlines; a removed revision never does.
    const update = (state: ReturnType<typeof usePreviewReviewStore.getState>) => {
      if (tracked.scope !== state.scope) clear();
      tracked.scope = state.scope;
      for (const [variant, render] of timers) {
        const entry = state.entries[variant];
        if (!entry || entry.dirty <= entry.reviewed || !sameRevision(render.entry, entry)) {
          clearTimeout(render.timer);
          timers.delete(variant);
        }
      }
      for (const [key, entry] of Object.entries(state.entries)) {
        const variant = Number(key);
        if (entry.dirty <= entry.reviewed || timers.has(variant)) continue;
        const token = entry;
        const timer = setTimeout(() => {
          if (timers.get(variant)?.token === token)
            setExpired((previous) => ({ ...previous, [variant]: token }));
        }, 250);
        timers.set(variant, { entry, token, timer });
      }
    };
    update(usePreviewReviewStore.getState());
    const stop = usePreviewReviewStore.subscribe(update);
    return () => {
      stop();
      clear();
    };
  }, []);
  return (canonical: number, scheduled: readonly number[], visible: boolean) =>
    Object.entries(entries).filter(([key, entry]) => {
      if (entry.canonical !== canonical || entry.dirty <= entry.reviewed) return false;
      const variant = Number(key);
      const render = pending.current.timers.get(variant);
      const timedOut =
        pending.current.scope === scope &&
        render &&
        sameRevision(render.entry, entry) &&
        expired[variant] === render.token;
      return !visible || !scheduled.includes(variant) || timedOut;
    }).length;
}
