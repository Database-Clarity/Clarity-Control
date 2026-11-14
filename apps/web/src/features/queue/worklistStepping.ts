import { create } from 'zustand';
import {
  queuePlace,
  visitOf,
  visitState,
  type QueueItem,
  type QueueVisit,
  type WorkQueue,
} from './model';
import { queueSources } from './sources';
import { useWorkQueues } from './store';

/**
 * Worklist stepping: while a Work-through queue is active in the editor (and the device setting is
 * on), the finder's stepping gestures (Shift+wheel, the wheel over the field, its arrow keys and
 * stepper) step the queue's items still to do, in Previous/Next order, instead of the finder's list.
 *
 * The editor's queue control publishes the visit it shows here; the finder reads it when a gesture
 * steps, so neither imports the other and typing never touches this store.
 */
export interface QueueStepper {
  queue: WorkQueue;
  visit: QueueVisit;
  isDone(item: QueueItem): boolean;
}

export const useQueueStepper = create<{ current: QueueStepper | null }>(() => ({ current: null }));

/** Publishes the active visit; the returned cleanup withdraws it unless a newer one replaced it. */
export function publishQueueStepper(stepper: QueueStepper): () => void {
  useQueueStepper.setState({ current: stepper });
  return () => {
    if (useQueueStepper.getState().current === stepper) useQueueStepper.setState({ current: null });
  };
}

/**
 * History state of the routes a worklist gesture steps through: the finder's live stepping lands
 * and commits plain paths, and each needs its queue visit back so the route stays in the queue.
 * The gesture's origin keeps the state it had; it is kept apart from the steps, because a gesture
 * can come back to the origin's path as a list step (the setting turned off mid-gesture), which
 * must not reopen the queue.
 */
const stepStates = new Map<string, unknown>();
let origin: { path: string; state: unknown } | null = null;

/** A new gesture starts with no remembered routes. */
export function clearStepStates() {
  stepStates.clear();
  origin = null;
}
/** The gesture's origin, once its first worklist step leaves it (kept for the whole gesture). */
export function rememberOrigin(path: string, state: unknown) {
  origin ??= { path, state };
}
/**
 * The state of the route a step went to: its queue visit, or none for a list step. List steps are
 * recorded only in a gesture that already carries queue states, so ordinary stepping is untouched.
 */
export function rememberStep(path: string, state: unknown) {
  if (state !== undefined || origin || stepStates.size) stepStates.set(path, state);
}
/**
 * The state to navigate `path` with, or undefined to leave the navigation as it is. `restoring`
 * is the history commit putting the gesture's origin back.
 */
export function stepStateFor(path: string, restoring: boolean): { state: unknown } | undefined {
  if (restoring && origin?.path === path) return { state: origin.state };
  return stepStates.has(path) ? { state: stepStates.get(path) } : undefined;
}
/** The queue visit a pending stepping target opens, when a worklist gesture stepped to it. */
export function pendingVisit(target: string | undefined): QueueVisit | null {
  return target === undefined ? null : visitOf(stepStates.get(target));
}

export type QueueStepTarget =
  | { kind: 'item'; item: QueueItem; path: string; state: ReturnType<typeof visitState> }
  | { kind: 'finish' }
  | undefined;

/**
 * Where a step from `key` goes: the neighbouring item still to do (Previous/Next's rule), or at
 * the last one Next's end of the queue. Nothing wraps; an ended queue steps only back.
 */
export function queueStepTarget(
  stepper: QueueStepper,
  key: string,
  direction: number,
): QueueStepTarget {
  const { queue, isDone } = stepper;
  const place = queuePlace(queue, key, isDone);
  const item = direction < 0 ? place.previous : place.finished ? undefined : place.next;
  if (item)
    return {
      kind: 'item',
      item,
      path: queueSources[queue.source].path(item),
      state: visitState({ id: queue.id, key: item.key }),
    };
  // Next on the last item: the queue control's own Finish (only from the route's own item).
  if (direction > 0 && !place.finished && place.current) return { kind: 'finish' };
  return undefined;
}

/** "q" + whether Previous and Next can step, for the finder's stepper; '' without a queue. */
export function queueEdges(stepper: QueueStepper | null): string {
  if (!stepper) return '';
  const back = queueStepTarget(stepper, stepper.visit.key, -1);
  const forward = queueStepTarget(stepper, stepper.visit.key, 1);
  return `q${back ? 1 : 0}${forward ? 1 : 0}`;
}

/** Next on the last item ends the queue there; the item counts as skipped while still open. */
export function finishQueue(stepper: QueueStepper, key: string) {
  const item = stepper.queue.items.find((entry) => entry.key === key);
  useWorkQueues.getState().finish(stepper.queue.id, key, Boolean(item && !stepper.isDone(item)));
}

/**
 * Items a gesture stepped past with Next. The route only lands on some of them (one per frame), so
 * the ones in between are marked skipped once the gesture ends, as Next past each would have.
 */
let passed: { id: string; keys: Set<string> } | null = null;
export function notePassed(id: string, key: string) {
  if (passed?.id !== id) passed = { id, keys: new Set() };
  passed.keys.add(key);
}
export function flushPassed() {
  const gesture = passed;
  passed = null;
  if (!gesture?.keys.size) return;
  const stepper = useQueueStepper.getState().current;
  const isDone = stepper?.queue.id === gesture.id ? stepper.isDone : () => false;
  const queue = useWorkQueues.getState().queues[gesture.id];
  if (!queue) return;
  const open = queue.items.filter((item) => gesture.keys.has(item.key) && !isDone(item));
  if (open.length)
    useWorkQueues.getState().skip(
      gesture.id,
      open.map((item) => item.key),
    );
}
