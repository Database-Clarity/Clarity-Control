import {
  newQueueId,
  visitState,
  type QueueItem,
  type QueueSourceId,
  type WorkQueue,
} from './model';
import { queueSources } from './sources';
import { useWorkQueues } from './store';

/** The queue whose control takes focus when it first shows (started from a list's entry bar). */
let entryFocus: string | null = null;
/** Whether the control of queue `id` should take focus now (once). */
export function takeEntryFocus(id: string): boolean {
  if (entryFocus !== id) return false;
  entryFocus = null;
  return true;
}

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
  focus = false,
}: {
  id?: string;
  source: QueueSourceId;
  scope: WorkQueue['scope'];
  items: QueueItem[];
  first: QueueItem;
  origin: WorkQueue['origin'];
  /** Focus the queue's control when the item opens (an entry button; not a row link). */
  focus?: boolean;
}): { to: string; state: ReturnType<typeof visitState> } {
  entryFocus = focus ? id : null;
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
