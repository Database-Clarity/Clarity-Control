import { useCallback, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useLostDecisions } from '../lost-text/decisions';
import { visitOf, type QueueItem, type QueueVisit, type WorkQueue } from './model';
import { queueSources, type SourceContext } from './sources';
import { useWorkQueues } from './store';

/** The source's context for completion tests and rebuilds, or null before data loads. */
export function useSourceContext(): SourceContext | null {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const decisions = useLostDecisions(user);
  return useMemo(() => (data ? { data, user, decisions } : null), [data, user, decisions]);
}

/**
 * Which of the queue's items are done, read live from the list's own completion test. Draft
 * changes run the test for every item (cheap lookups), but the caller renders again only when an
 * answer changes, so typing in the editor costs no render here.
 */
export function useQueueDone(queue: WorkQueue | undefined): (item: QueueItem) => boolean {
  const context = useSourceContext();
  // Keyed on the frozen items, not the queue record: a step (new position) keeps the test and its
  // cached answers.
  const source = queue?.source;
  const items = queue?.items;
  const test = useMemo(
    () => (source && context ? queueSources[source].done(context) : undefined),
    [source, context],
  );
  const bits = useDraftStore((state) =>
    test && items ? items.map((item) => (test(item, state.drafts) ? '1' : '0')).join('') : '',
  );
  const index = useMemo(() => new Map(items?.map((item, at) => [item.key, at]) ?? []), [items]);
  return useCallback(
    (item: QueueItem) => (bits ? bits[index.get(item.key) ?? -1] === '1' : false),
    [bits, index],
  );
}

export type WorkThrough =
  { mode: 'active'; queue: WorkQueue; visit: QueueVisit } | { mode: 'paused'; queue: WorkQueue };

/**
 * The work-through queue a route shows: active when the history entry names a queue this tab
 * holds; paused when the tab is working through a queue but this visit is an ordinary one (the
 * finder, a link, another workspace). `allowPaused` is false where a paused queue has no place.
 */
export function useWorkThrough(routeState: unknown, allowPaused = true): WorkThrough | null {
  const visit = visitOf(routeState);
  const visited = useWorkQueues((state) => (visit ? state.queues[visit.id] : undefined));
  const active = useWorkQueues((state) =>
    allowPaused && state.active ? state.queues[state.active] : undefined,
  );
  if (visit && visited) return { mode: 'active', queue: visited, visit };
  if (active && !active.finished) return { mode: 'paused', queue: active };
  return null;
}

/**
 * A list page that Leave came back to ends the queue it left (named in the history entry's state).
 * The queue ends only once the list is reached: a Leave the leave guard refuses, or one opened in
 * another tab, leaves it running. Back to the queue's entry works it again; Forward here leaves.
 */
export function useLeftQueue(): void {
  const { key, state } = useLocation();
  const left = (state as { workThroughLeft?: unknown } | null)?.workThroughLeft;
  useEffect(() => {
    if (typeof left !== 'string') return;
    const store = useWorkQueues.getState();
    if (store.active === left) store.end(left);
  }, [key, left]);
}
