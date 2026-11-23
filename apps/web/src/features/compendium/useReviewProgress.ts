import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../services/http';
import { emptyProgress, readProgress, type ReviewProgress } from './reviewProgress';
import { notifyCompendiumInputs } from './inputEvents';

type ViewState = Pick<ReviewProgress, 'selected' | 'query' | 'category' | 'filter'>;
function viewState({ selected, query, category, filter }: ReviewProgress): ViewState {
  return { selected, query, category, filter };
}
function sameView(left: ViewState, right: ViewState) {
  return (
    left.selected === right.selected &&
    left.query === right.query &&
    left.category === right.category &&
    left.filter === right.filter
  );
}
type PendingView = {
  view: ViewState;
  report: (error?: unknown) => void;
  cancel: () => void;
};
// Keep pending navigation across route unmounts, without flushing in a React commit.
const pendingViews = new Map<string, PendingView>();
function removePending(key: string) {
  pendingViews.get(key)?.cancel();
  pendingViews.delete(key);
  if (!pendingViews.size) {
    window.removeEventListener('pagehide', flushViews);
    document.removeEventListener('visibilitychange', flushHiddenViews);
  }
}
function flushView(key: string) {
  const pending = pendingViews.get(key);
  if (!pending) return;
  pending.cancel();
  try {
    const raw = localStorage.getItem(key);
    // Navigation must not replace decisions saved by another tab while we waited.
    const current = readProgress({ getItem: () => raw }, key);
    if (!sameView(current, pending.view))
      localStorage.setItem(key, JSON.stringify({ ...current, ...pending.view }));
    removePending(key);
    pending.report();
  } catch (error) {
    // Retain the latest view for a later navigation or lifecycle flush to retry.
    pending.report(error);
  }
}
function flushViews() {
  for (const key of pendingViews.keys()) flushView(key);
}
function flushHiddenViews() {
  if (document.visibilityState === 'hidden') flushViews();
}
function queueView(key: string, progress: ReviewProgress, report: PendingView['report']) {
  pendingViews.get(key)?.cancel();
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    if (window.requestIdleCallback) {
      idle = window.requestIdleCallback(() => flushView(key), { timeout: 500 });
    } else idle = window.setTimeout(() => flushView(key), 0);
  }, 150);
  pendingViews.set(key, {
    view: viewState(progress),
    report,
    cancel: () => {
      window.clearTimeout(timer);
      if (idle !== undefined) {
        if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
        else window.clearTimeout(idle);
      }
    },
  });
  window.addEventListener('pagehide', flushViews);
  document.addEventListener('visibilitychange', flushHiddenViews);
}

type Decisions = ReviewProgress['decisions'];
/** `stored` with what changed from `before` to `after` applied, removals included. */
function withChanges(stored: Decisions, before: Decisions, after: Decisions): Decisions {
  const merged = { ...stored };
  for (const hash of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (after[hash] === before[hash]) continue;
    if (after[hash]) merged[hash] = after[hash];
    else delete merged[hash];
  }
  return merged;
}

// Mount the queue with key=storageKey so identity changes cannot copy another user's state.
export function useReviewProgress(storageKey: string) {
  const [initial] = useState(() => {
    try {
      return {
        progress: {
          ...readProgress(localStorage, storageKey),
          ...pendingViews.get(storageKey)?.view,
        },
        error: '',
      };
    } catch (error) {
      return { progress: emptyProgress(), error: errorMessage(error) };
    }
  });
  const [progress, setProgress] = useState(initial.progress);
  const [error, setError] = useState(initial.error);
  const current = useRef(progress);
  /** The decisions as this device last stored them: what differs is still this tab's to write. */
  const saved = useRef(progress.decisions);
  const mounted = useRef(false);
  const decisionWriteFailed = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // Another tab's decisions show here at once, under this tab's own unwritten ones.
    function changed(event: StorageEvent) {
      if (event.key !== storageKey || event.newValue === null) return;
      try {
        const stored = readProgress({ getItem: () => event.newValue }, storageKey).decisions;
        const next = {
          ...current.current,
          decisions: withChanges(stored, saved.current, current.current.decisions),
        };
        saved.current = stored;
        current.current = next;
        setProgress(next);
      } catch {
        // The other tab's record is unreadable here: this one keeps what it has.
      }
    }
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', changed);
    };
  }, [storageKey]);
  function report(writeError?: unknown) {
    if (!mounted.current) return;
    if (writeError !== undefined)
      setError(`Review progress is only in memory: ${errorMessage(writeError)}`);
    else if (!decisionWriteFailed.current) setError('');
  }
  function update(update: (current: ReviewProgress) => ReviewProgress) {
    const previous = current.current;
    const next = update(previous);
    const decisionChanged = next.decisions !== previous.decisions;
    if (!decisionChanged && sameView(previous, next)) return;
    current.current = next;
    setProgress(next);
    if (!decisionChanged) {
      queueView(storageKey, next, report);
      return;
    }
    // Authored review decisions retain their existing immediate durability guarantee.
    removePending(storageKey);
    try {
      // Another tab may have decided other entries since: write only what changed here.
      const raw = localStorage.getItem(storageKey);
      let stored = saved.current;
      try {
        stored = readProgress({ getItem: () => raw }, storageKey).decisions;
      } catch {
        // An unreadable record (already reported) is replaced, as before.
      }
      const merged = { ...next, decisions: withChanges(stored, saved.current, next.decisions) };
      current.current = merged;
      setProgress(merged);
      const serialized = JSON.stringify(merged);
      if (localStorage.getItem(storageKey) !== serialized) {
        localStorage.setItem(storageKey, serialized);
        notifyCompendiumInputs(storageKey);
      }
      saved.current = merged.decisions;
      decisionWriteFailed.current = false;
      setError('');
    } catch (error) {
      decisionWriteFailed.current = true;
      setError(`Review progress is only in memory: ${errorMessage(error)}`);
    }
  }
  return { progress, update, error };
}
