import { useCallback, useState, useSyncExternalStore } from 'react';
import { usePreviewReviewStore, type ReviewEntry } from '../../stores/previewReview';

export interface PreviewWarningContext {
  canonical: number;
  scheduled: readonly number[];
  visible: boolean;
}
interface PendingRender {
  entry: ReviewEntry;
  timer: ReturnType<typeof setTimeout>;
  expired: boolean;
}

/** Track revision lifetimes independently of React renders, including batched clear/re-edit. */
function createWarnings() {
  const timers = new Map<number, PendingRender>();
  let scope: string | null | undefined;
  const clear = () => {
    for (const render of timers.values()) clearTimeout(render.timer);
    timers.clear();
  };
  const sameRevision = (previous: ReviewEntry, current: ReviewEntry) =>
    previous.canonical === current.canonical && previous.dirty === current.dirty;
  return {
    subscribe(notify: () => void) {
      const update = (state: ReturnType<typeof usePreviewReviewStore.getState>) => {
        if (scope !== state.scope) clear();
        scope = state.scope;
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
          const render: PendingRender = {
            entry,
            expired: false,
            timer: setTimeout(() => {
              if (timers.get(variant) !== render) return;
              render.expired = true;
              notify();
            }, 250),
          };
          timers.set(variant, render);
        }
        notify();
      };
      update(usePreviewReviewStore.getState());
      const stop = usePreviewReviewStore.subscribe(update);
      return () => {
        stop();
        clear();
      };
    },
    count(context: PreviewWarningContext) {
      const state = usePreviewReviewStore.getState();
      return Object.entries(state.entries).filter(([key, entry]) => {
        if (entry.canonical !== context.canonical || entry.dirty <= entry.reviewed) return false;
        const variant = Number(key);
        const render = timers.get(variant);
        const expired =
          scope === state.scope && render?.expired && sameRevision(render.entry, entry);
        return !context.visible || !context.scheduled.includes(variant) || expired;
      }).length;
    },
  };
}

/**
 * Only the warning count subscribes: successful visible renders leave it at zero, so their
 * acknowledgements never rerender the editor workspace. The guard/save ledger stays immediate.
 * Each scheduled revision gets its own 250 ms watchdog, unaffected by unrelated updates or
 * older acknowledgements. Clearing, replacing, changing accounts, or unmounting cancels it.
 */
export function usePreviewWarnings(context?: PreviewWarningContext): number {
  const [warnings] = useState(createWarnings);
  const active = context !== undefined;
  const subscribe = useCallback(
    (notify: () => void) => (active ? warnings.subscribe(notify) : () => undefined),
    [active, warnings],
  );
  return useSyncExternalStore(
    subscribe,
    () => (context ? warnings.count(context) : 0),
    () => 0,
  );
}
