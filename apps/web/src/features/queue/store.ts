import { create } from 'zustand';
import { batchIdSchema } from '@clarity/core/schedule';
import type { QueueItem, WorkQueue } from './model';

/**
 * Where work-through queues live: this browser tab's session storage, with the history entry's
 * state naming the queue and item (`visitState`).
 *
 * Why session storage (and not the queue itself in history state): a queue is one record that
 * every visit in it updates (position, skipped items, finished). History state belongs to one
 * entry and the app cannot rewrite earlier entries, so Back would bring back stale copies; a
 * record keyed by id is shared by every entry. Session storage survives a reload, Back and Forward,
 * and a switch to another workspace, and it stays per tab, so two tabs never fight over one queue.
 * The URL stays the tooltip's own: a copied link opens an ordinary visit in any tab.
 */
const storageKey = 'clarity-work-through:v1';
/** Queues kept for Back and Forward after a newer one starts. */
const kept = 5;

interface Stored {
  /** The queue this tab is working through; null after Leave or End. */
  active: string | null;
  queues: Record<string, WorkQueue>;
}

/**
 * A queue's frozen items live under their own key, written only when the queue starts or is
 * rebuilt: a step (Next, Previous) then writes only the small record (position, skipped), however
 * long the list.
 */
const itemsKey = (id: string) => `${storageKey}:items:${id}`;

/** The session copy, as a reload reads it. */
export function readStoredQueues(): Stored {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (raw && typeof raw === 'object' && 'queues' in raw) {
      const stored = raw as Stored;
      const queues: Record<string, WorkQueue> = {};
      for (const [id, record] of Object.entries(stored.queues ?? {})) {
        let items: unknown;
        try {
          items = JSON.parse(sessionStorage.getItem(itemsKey(id)) ?? 'null');
        } catch {
          // A corrupt item list must not hide the tab's other queues.
          continue;
        }
        const queue = { ...record, items } as WorkQueue;
        if (queue.version !== 1 || !Array.isArray(items) || !Array.isArray(queue.skipped)) continue;
        if (queue.destination != null) {
          const destination = queue.destination;
          if (
            import.meta.env.VITE_SCHEDULED_ENABLED !== '1' ||
            destination.kind !== 'batch' ||
            !batchIdSchema.safeParse(destination.batchId).success ||
            typeof destination.batchName !== 'string' ||
            !destination.batchName.trim() ||
            destination.batchName.length > 80 ||
            queue.source !== 'translations' ||
            queue.items.some(
              (item) =>
                !item ||
                typeof item !== 'object' ||
                (item.detail as { batchId?: unknown } | null)?.batchId !== destination.batchId,
            )
          )
            continue;
        } else queue.destination = null;
        queues[id] = queue;
      }
      return { active: stored.active && queues[stored.active] ? stored.active : null, queues };
    }
  } catch {
    // Unreadable storage: start without queues.
  }
  return { active: null, queues: {} };
}

/** Writes the records; `items` names the queues whose item lists changed (start, rebuild). */
function write(stored: Stored, items: string[] = [], dropped: string[] = []) {
  try {
    for (const id of dropped) sessionStorage.removeItem(itemsKey(id));
    for (const id of items)
      sessionStorage.setItem(itemsKey(id), JSON.stringify(stored.queues[id]!.items));
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        active: stored.active,
        queues: Object.fromEntries(
          Object.entries(stored.queues).map(([id, queue]) => [id, { ...queue, items: undefined }]),
        ),
      }),
    );
  } catch {
    // Full or blocked storage: the queue still works until the tab reloads.
  }
}

interface QueueStore extends Stored {
  start(queue: WorkQueue): void;
  /** The route opened `key` in queue `id`: it becomes current, and an item passed by Next is skipped. */
  visit(id: string, key: string, passedOpen: boolean): void;
  /** Items a stepping gesture passed with Next while they were open (worklist stepping). */
  skip(id: string, keys: string[]): void;
  /** Next on the last item: the queue ends here (the item is skipped when still open). */
  finish(id: string, key: string, open: boolean): void;
  /** Leaves the end-of-queue state so the remaining items can be worked through again. */
  revisit(id: string): void;
  /** New membership from the source list (Rebuild queue). */
  rebuild(id: string, items: QueueItem[]): void;
  /** Leave or End: the tab no longer works through it (Back still finds it). */
  end(id: string): void;
}

function update(
  state: Stored,
  id: string,
  change: (queue: WorkQueue) => WorkQueue,
  active: string | null = id,
): Partial<Stored> {
  const queue = state.queues[id];
  if (!queue) return {};
  const changed = change(queue);
  const next = { active, queues: { ...state.queues, [id]: changed } };
  write(next, changed.items === queue.items ? [] : [id]);
  return next;
}

export const useWorkQueues = create<QueueStore>((set) => ({
  ...readStoredQueues(),
  start(queue) {
    set((state) => {
      const recent = Object.values(state.queues)
        .filter((old) => old.id !== queue.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, kept - 1);
      const next = {
        active: queue.id,
        queues: Object.fromEntries([...recent, queue].map((q) => [q.id, q])),
      };
      write(
        next,
        [queue.id],
        Object.keys(state.queues).filter((id) => !next.queues[id]),
      );
      return next;
    });
  },
  visit(id, key, passedOpen) {
    set((state) => {
      const queue = state.queues[id];
      if (!queue) return {};
      const from = queue.items.findIndex((item) => item.key === queue.current);
      const to = queue.items.findIndex((item) => item.key === key);
      if (queue.current === key && !queue.finished && state.active === id) return {};
      return update(state, id, (old) => ({
        ...old,
        current: key,
        finished: old.current === key ? old.finished : false,
        skipped:
          passedOpen && to > from && from >= 0 && !old.skipped.includes(old.current)
            ? [...old.skipped, old.current]
            : old.skipped,
      }));
    });
  },
  skip(id, keys) {
    set((state) => {
      const queue = state.queues[id];
      const added = keys.filter((key) => !queue?.skipped.includes(key));
      if (!queue || !added.length) return {};
      return update(
        state,
        id,
        (old) => ({ ...old, skipped: [...old.skipped, ...added] }),
        state.active,
      );
    });
  },
  finish(id, key, open) {
    set((state) =>
      update(state, id, (old) => ({
        ...old,
        current: key,
        finished: true,
        skipped: open && !old.skipped.includes(key) ? [...old.skipped, key] : old.skipped,
      })),
    );
  },
  revisit(id) {
    set((state) => update(state, id, (old) => ({ ...old, finished: false })));
  },
  rebuild(id, items) {
    set((state) =>
      update(state, id, (old) => {
        const keys = new Set(items.map((item) => item.key));
        return {
          ...old,
          items,
          skipped: old.skipped.filter((key) => keys.has(key)),
          current: keys.has(old.current) ? old.current : (items[0]?.key ?? old.current),
          finished: false,
        };
      }),
    );
  },
  end(id) {
    set((state) => (state.active === id ? update(state, id, (queue) => queue, null) : {}));
  },
}));

/** For tests: forget every queue. */
export function resetWorkQueues() {
  try {
    for (const id of Object.keys(useWorkQueues.getState().queues))
      sessionStorage.removeItem(itemsKey(id));
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
  useWorkQueues.setState({ active: null, queues: {} });
}
