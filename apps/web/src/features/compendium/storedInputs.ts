import { guidanceCacheSchema } from './guidanceSchema';
import { displayInputKey } from './matchingSession';
import { emptyProgress, progressSchema, reviewStorageKey } from './reviewProgress';
import { compendiumInputEvent } from './inputEvents';

function createStore(scope: string, apiScope: string, userId?: string | number) {
  const guidanceKey = `clarity-review-guidance:v1:${encodeURIComponent(scope)}`;
  const progressKey = reviewStorageKey(`${scope}|${apiScope}`, userId);
  type Cache = ReturnType<typeof guidanceCacheSchema.parse>;
  type Inputs = {
    key: string;
    cached?: Cache;
    local?: Cache['document'];
    progress: ReturnType<typeof emptyProgress>;
    error?: string;
  };
  let guidanceRaw: string | null | undefined;
  let progressRaw: string | null | undefined;
  let value: Inputs;
  const listeners = new Set<() => void>();
  function read(): Inputs {
    let next: Inputs;
    try {
      const guidance = localStorage.getItem(guidanceKey);
      const progress = localStorage.getItem(progressKey);
      if (value && guidance === guidanceRaw && progress === progressRaw) return value;
      guidanceRaw = guidance;
      progressRaw = progress;
      const cached = guidance ? guidanceCacheSchema.parse(JSON.parse(guidance)) : undefined;
      const parsedProgress = progress
        ? progressSchema.parse(JSON.parse(progress))
        : emptyProgress();
      const key = displayInputKey({
        drafts: {},
        progress: parsedProgress,
        local: cached?.document,
        scope,
      });
      next = { key, cached, local: cached?.document, progress: parsedProgress };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      next = { key: `error:${message}`, progress: emptyProgress(), error: message };
    }
    if (
      value?.key === next.key &&
      (!import.meta.env.DEV ||
        (value.cached?.revision === next.cached?.revision &&
          value.cached?.pending === next.cached?.pending))
    )
      return value;
    return next;
  }
  value = read();
  const check = (event?: Event) => {
    const relevant = (key: string | null) =>
      key === null || key === guidanceKey || key === progressKey;
    if (event?.type === 'storage' && !relevant((event as StorageEvent).key)) return;
    if (event?.type === compendiumInputEvent && !relevant((event as CustomEvent<string>).detail))
      return;
    const next = read();
    if (next !== value) {
      value = next;
      for (const listener of listeners) listener();
    }
  };
  return {
    getSnapshot: () => value,
    get active() {
      return listeners.size > 0;
    },
    subscribe(listener: () => void) {
      if (!listeners.size) {
        window.addEventListener('focus', check);
        window.addEventListener('storage', check);
        window.addEventListener(compendiumInputEvent, check);
      }
      listeners.add(listener);
      check();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          window.removeEventListener('focus', check);
          window.removeEventListener('storage', check);
          window.removeEventListener(compendiumInputEvent, check);
        }
      };
    },
  };
}
const stores = new Map<string, ReturnType<typeof createStore>>();
export function storedInputs(scope: string, apiScope: string, userId?: string | number) {
  const key = JSON.stringify([scope, apiScope, userId]);
  let store = stores.get(key);
  if (!store) {
    store = createStore(scope, apiScope, userId);
    stores.set(key, store);
    for (const [oldKey, old] of stores) {
      if (stores.size <= 8) break;
      if (oldKey !== key && !old.active) stores.delete(oldKey);
    }
  }
  return store;
}
export type StoredInputs = ReturnType<ReturnType<typeof storedInputs>['getSnapshot']>;
