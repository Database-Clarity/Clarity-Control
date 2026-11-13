import {
  newQueueId,
  visitState,
  type QueueItem,
  type QueueSourceId,
  type WorkQueue,
} from './model';
import { queueSources } from './sources';
import { useWorkQueues } from './store';

/**
 * Starts a queue of `items` (frozen from here on) at `first`, and returns where to go: the item's
 * own URL and the history state that names the queue. `id` lets a link carry the state before the
 * queue exists (the Translations rows: the queue starts in the click, before the link navigates).
 */
export function startQueue({
  id = newQueueId(),
  source,
  scope,
  items,
  first,
  origin,
}: {
  id?: string;
  source: QueueSourceId;
  scope: WorkQueue['scope'];
  items: QueueItem[];
  first: QueueItem;
  origin: WorkQueue['origin'];
}): { to: string; state: ReturnType<typeof visitState> } {
  useWorkQueues.getState().start({
    version: 1,
    id,
    source,
    scope,
    origin,
    items,
    skipped: [],
    current: first.key,
    finished: false,
    createdAt: Date.now(),
    destination: null,
  });
  return {
    to: queueSources[source].path(first),
    state: visitState({ id, key: first.key }),
  };
}
