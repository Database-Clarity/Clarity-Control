import { useCallback, useMemo } from 'react';
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
  const test = useMemo(
    () => (queue && context ? queueSources[queue.source].done(context) : undefined),
    [queue, context],
  );
  const bits = useDraftStore((state) =>
    test && queue ? queue.items.map((item) => (test(item, state.drafts) ? '1' : '0')).join('') : '',
  );
  const index = useMemo(
    () => new Map(queue?.items.map((item, at) => [item.key, at]) ?? []),
    [queue],
  );
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
