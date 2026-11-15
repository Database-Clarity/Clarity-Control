import { create } from 'zustand';
import { z } from 'zod';
import {
  storedWorklistSchema,
  worklistOperationSchema,
  worklistIndexEntrySchema,
  worklistsSchema,
  applyWorklistOperation,
  type SavedWorklist,
  type WorklistEntry,
  type WorklistOperation,
} from '../../../../../packages/core/src/worklists';
import { apiRequest } from '../../services/apiAuth';
import { useAuthStore } from '../../stores/auth';
import { sessionToken } from '../../services/session';
const replySchema = z.object({
  worklist: storedWorklistSchema.extend({ id: z.string().uuid() }).nullable(),
  revision: z.string().nullable(),
});
const indexSchema = z.object({ lists: z.array(worklistIndexEntrySchema).max(50) });
const pendingSchema = z.array(z.object({ id: z.string().uuid(), op: worklistOperationSchema }));
type Pending = z.infer<typeof pendingSchema>;
type Meta = z.infer<typeof worklistIndexEntrySchema>;
interface State {
  scope: string;
  base: SavedWorklist[];
  lists: SavedWorklist[];
  ops: Pending;
  loaded: string[];
  index: Record<string, Meta>;
  pending: boolean;
  notice: string;
  storageFailed: boolean;
  change(lists: SavedWorklist[]): void;
  add(id: string | null, name: string, items: WorklistEntry[]): void;
}
let epoch = 0;
let flight = false;
let refreshAfterFlight = false;
let sendAfterFlight = false;
const signals = new Set<string>();
let ready = false;
const versions = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
const tabKey = 'clarity-worklists-tab:v3';
let tab: string | undefined;
function tabId() {
  if (tab) return tab;
  try {
    tab = sessionStorage.getItem(tabKey) ?? crypto.randomUUID();
    sessionStorage.setItem(tabKey, tab);
  } catch {
    tab = crypto.randomUUID();
  }
  return tab;
}
const cacheKey = (scope: string) => `clarity-worklists:v3:${scope}`;
const opsKey = (scope: string) => `${cacheKey(scope)}:pending:${tabId()}`;
const signalKey = (scope: string) => `${cacheKey(scope)}:invalidate`;
const empty = () => ({
  base: [],
  lists: [],
  ops: [],
  loaded: [],
  index: {},
  pending: false,
  storageFailed: false,
  notice: '',
});
function accountReady() {
  const auth = useAuthStore.getState();
  if (auth.loading || !auth.user || String(auth.user.id) !== useSavedWorklists.getState().scope)
    return false;
  try {
    return auth.token === null || auth.token === sessionToken();
  } catch {
    return false;
  }
}
function project(base: SavedWorklist[], ops: Pending): SavedWorklist[] {
  const rows = new Map(base.map((row) => [row.id, row]));
  for (const { id, op } of ops) {
    const previous = rows.get(id);
    const next = applyWorklistOperation(
      previous ? { name: previous.name, hashes: previous.items.map((item) => item.hash) } : null,
      op,
    );
    if (!next) rows.delete(id);
    else
      rows.set(id, {
        id,
        name: next.name,
        items: next.hashes.map((hash) => ({
          hash,
          name: previous?.items.find((item) => item.hash === hash)?.name ?? '',
        })),
      });
  }
  return [...rows.values()];
}
function render() {
  const state = useSavedWorklists.getState();
  useSavedWorklists.setState({
    lists: project(state.base, state.ops),
    pending: state.ops.length > 0,
    loaded: [
      ...new Set([
        ...state.loaded,
        ...state.ops.filter((item) => item.op.type === 'create').map((item) => item.id),
      ]),
    ],
  });
}
function keepOps() {
  const state = useSavedWorklists.getState();
  try {
    localStorage.setItem(opsKey(state.scope), JSON.stringify(state.ops));
    useSavedWorklists.setState({ storageFailed: false });
  } catch {
    useSavedWorklists.setState({
      storageFailed: true,
      notice: 'Keep this tab open: browser storage could not keep your pending operations.',
    });
  }
}
function keepCache() {
  const { scope, base, loaded, index } = useSavedWorklists.getState();
  try {
    localStorage.setItem(cacheKey(scope), JSON.stringify({ base, loaded, index }));
  } catch {
    /* Pending operations have separate protection. */
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void syncWorklists(), 600);
}
function enqueue(id: string, op: WorklistOperation) {
  const state = useSavedWorklists.getState();
  if (state.scope === 'anonymous') throw new Error('Sign in to save worklists.');
  const ops = [...state.ops, { id, op }];
  if (!worklistsSchema.safeParse(project(state.base, ops)).success)
    throw new Error(
      'Worklists allow up to 50 lists and 16 KB of hashes per list, and names of 1–80 characters.',
    );
  useSavedWorklists.setState({ ops, notice: 'Saving changes…' });
  render();
  keepOps();
  schedule();
}
export const useSavedWorklists = create<State>(() => ({
  scope: 'anonymous',
  ...empty(),
  change(next) {
    const current = useSavedWorklists.getState().lists;
    const deleted = current.find((row) => !next.some((item) => item.id === row.id));
    if (deleted) {
      enqueue(deleted.id, { type: 'delete' });
      return;
    }
    for (const row of next) {
      const previous = current.find((item) => item.id === row.id);
      if (!previous) {
        enqueue(row.id, {
          type: 'create',
          name: row.name,
          hashes: row.items.map((item) => item.hash),
        });
        return;
      }
      if (row.name !== previous.name) {
        enqueue(row.id, { type: 'rename', name: row.name });
        return;
      }
      const removed = previous.items
        .filter((item) => !row.items.some((next) => next.hash === item.hash))
        .map((item) => item.hash);
      if (removed.length) {
        enqueue(row.id, { type: 'remove', hashes: removed });
        return;
      }
      const added = row.items
        .filter((item) => !previous.items.some((old) => old.hash === item.hash))
        .map((item) => item.hash);
      if (added.length) {
        enqueue(row.id, { type: 'add', hashes: added });
        return;
      }
      const moved = row.items.findIndex((item, index) => item.hash !== previous.items[index]?.hash);
      if (moved >= 0) {
        enqueue(row.id, { type: 'move', hash: row.items[moved]!.hash, index: moved });
        return;
      }
    }
  },
  add(id, name, items) {
    const row = useSavedWorklists.getState().lists.find((row) => row.id === id);
    if (id && !row) throw new Error('This worklist was deleted. Choose another worklist.');
    const hashes = [...new Set(items.map((item) => item.hash))];
    enqueue(
      id ?? crypto.randomUUID(),
      row ? { type: 'add', hashes } : { type: 'create', name: name.trim(), hashes },
    );
  },
}));
const entryPath = (id: string) => `/worklists/${encodeURIComponent(id)}`;
function accept(id: string, reply: z.infer<typeof replySchema>) {
  const state = useSavedWorklists.getState();
  versions.set(id, (versions.get(id) ?? 0) + 1);
  const base = state.base.filter((row) => row.id !== id);
  const index = { ...state.index };
  if (reply.worklist && reply.revision) {
    base.push({
      id,
      name: reply.worklist.name,
      items: reply.worklist.hashes.map((hash) => ({ hash, name: '' })),
    });
    index[id] = {
      id,
      name: reply.worklist.name,
      count: reply.worklist.hashes.length,
      updatedAt: Date.now(),
      revision: reply.revision,
    };
  } else delete index[id];
  useSavedWorklists.setState({ base, index, loaded: [...new Set([...state.loaded, id])] });
  render();
}
async function readRow(id: string, started: number) {
  const version = versions.get(id);
  const response = await apiRequest(entryPath(id));
  if (!response.ok) throw new Error('Could not load this worklist. Retry when connected.');
  const reply = replySchema.parse(await response.json());
  if (started !== epoch || !accountReady()) throw new Error('The account changed.');
  if (version === versions.get(id)) accept(id, reply);
  return reply;
}
export async function loadWorklist(id: string): Promise<SavedWorklist> {
  const state = useSavedWorklists.getState();
  if (!state.lists.some((row) => row.id === id)) throw new Error('The saved worklist was deleted.');
  if (!state.loaded.includes(id)) {
    if (!accountReady()) throw new Error('Wait for this account to finish signing in.');
    await readRow(id, epoch);
    keepCache();
  }
  const row = useSavedWorklists.getState().lists.find((row) => row.id === id);
  if (!row)
    throw new Error('This worklist was deleted on another device. Sync to update the index.');
  return row;
}
async function readIndex(started: number) {
  const before = useSavedWorklists.getState().index;
  const response = await apiRequest('/worklists');
  if (!response.ok) throw new Error('Could not read the worklist index.');
  const remote = indexSchema.parse(await response.json());
  if (started !== epoch || !accountReady()) return;
  const state = useSavedWorklists.getState();
  const index = Object.fromEntries(remote.lists.map((meta) => [meta.id, meta]));
  for (const [id, meta] of Object.entries(state.index))
    if (meta.revision !== before[id]?.revision) index[id] = meta;
  const loaded = state.loaded.filter((id) => index[id]?.revision === state.index[id]?.revision);
  const base = Object.values(index).map(
    (meta) =>
      ((loaded.includes(meta.id) || state.ops.some((op) => op.id === meta.id)) &&
        state.base.find((row) => row.id === meta.id)) || {
        id: meta.id,
        name: meta.name,
        items: [],
      },
  );
  useSavedWorklists.setState({ base, index, loaded });
  render();
  ready = true;
}
/** Sends operations in order. A conflict gets one fresh-row retry, never a snapshot merge. */
export async function syncWorklists(refresh = false) {
  if (refresh) ready = false;
  if (flight) {
    if (refresh) refreshAfterFlight = true;
    else sendAfterFlight = true;
    return;
  }
  clearTimeout(timer);
  if (!accountReady()) return;
  flight = true;
  const started = epoch;
  try {
    if (!ready) await readIndex(started);
    if (started !== epoch || !accountReady()) return;
    while (useSavedWorklists.getState().ops.length) {
      const pending = useSavedWorklists.getState().ops[0]!;
      if (
        pending.op.type !== 'create' &&
        pending.op.type !== 'delete' &&
        !useSavedWorklists.getState().loaded.includes(pending.id)
      )
        await readRow(pending.id, started);
      let success = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = useSavedWorklists.getState();
        const response = await apiRequest(entryPath(pending.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            op: pending.op,
            revision: state.index[pending.id]?.revision ?? null,
          }),
        });
        if (started !== epoch || !accountReady()) return;
        if (response.status === 409) {
          if (attempt === 1)
            throw new Error('Worklist kept changing on another device. Use Sync to retry.');
          await readRow(pending.id, started);
          continue;
        }
        if (!response.ok) throw new Error('Could not sync this worklist. Retry when connected.');
        const reply = replySchema.parse(await response.json());
        if (started !== epoch || !accountReady()) return;
        accept(pending.id, reply);
        useSavedWorklists.setState({ ops: useSavedWorklists.getState().ops.slice(1) });
        render();
        keepOps();
        keepCache();
        try {
          localStorage.setItem(
            signalKey(useSavedWorklists.getState().scope),
            JSON.stringify({ id: pending.id, nonce: crypto.randomUUID() }),
          );
        } catch {
          /* Focus/Sync also refresh. */
        }
        success = true;
        break;
      }
      if (!success) return;
    }
    keepCache();
    useSavedWorklists.setState({ notice: 'Saved to your account.' });
  } catch (error) {
    if (started === epoch)
      useSavedWorklists.setState({
        notice: `${useSavedWorklists.getState().storageFailed ? 'Keep this tab open: browser storage could not keep your pending operations. ' : ''}${error instanceof Error ? error.message : 'Sync failed.'}`,
      });
  } finally {
    try {
      await readSignals(started);
    } catch {
      /* A later focus/Sync retries incoming reads. */
    }
    flight = false;
    if (sendAfterFlight && useSavedWorklists.getState().pending) {
      sendAfterFlight = false;
      schedule();
    }
    if (refreshAfterFlight || started !== epoch) {
      refreshAfterFlight = false;
      ready = false;
      schedule();
    }
  }
}
async function readSignals(started: number) {
  const received = signals.size > 0;
  while (signals.size && started === epoch && accountReady()) {
    const id = [...signals][0]!;
    signals.delete(id);
    await readRow(id, started);
  }
  if (received && started === epoch && accountReady()) await readIndex(started);
}
export function connectWorklists(): () => void {
  const account = () => {
    const auth = useAuthStore.getState();
    const scope = String(auth.user?.id ?? 'anonymous');
    if (auth.loading) {
      epoch++;
      ready = false;
      return;
    }
    if (scope === useSavedWorklists.getState().scope) {
      if (!ready) void syncWorklists();
      return;
    }
    epoch++;
    signals.clear();
    ready = false;
    clearTimeout(timer);
    let base: SavedWorklist[] = [];
    let loaded: string[] = [];
    let index: Record<string, Meta> = {};
    let ops: Pending = [];
    try {
      const cache = z
        .object({
          base: worklistsSchema,
          loaded: z.array(z.string()),
          index: z.record(z.string(), worklistIndexEntrySchema),
        })
        .parse(JSON.parse(localStorage.getItem(cacheKey(scope)) ?? 'null'));
      ({ base, loaded, index } = cache);
    } catch {
      /* Preserve unreadable cache on disk. */
    }
    try {
      ops = pendingSchema.parse(JSON.parse(localStorage.getItem(opsKey(scope)) ?? '[]'));
    } catch {
      /* Preserve unreadable pending copy. */
    }
    useSavedWorklists.setState({ scope, ...empty(), base, loaded, index, ops });
    render();
    void syncWorklists();
  };
  const unsubscribe = useAuthStore.subscribe(account);
  account();
  const retry = () => void syncWorklists(true);
  const storage = async (event: StorageEvent) => {
    const state = useSavedWorklists.getState();
    if (event.key !== signalKey(state.scope) || !event.newValue || !accountReady()) return;
    const started = epoch;
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(JSON.parse(event.newValue));
      signals.add(id);
      if (flight) return;
      flight = true;
      try {
        await readSignals(started);
      } finally {
        flight = false;
        if (sendAfterFlight && useSavedWorklists.getState().pending) {
          sendAfterFlight = false;
          schedule();
        }
      }
      // Receiving state changes neither persisted pending ops nor publication keys.
    } catch (error) {
      if (started === epoch)
        useSavedWorklists.setState({
          notice: error instanceof Error ? error.message : 'Sync failed.',
        });
    }
  };
  window.addEventListener('online', retry);
  window.addEventListener('focus', retry);
  window.addEventListener('storage', storage);
  return () => {
    unsubscribe();
    window.removeEventListener('online', retry);
    window.removeEventListener('focus', retry);
    window.removeEventListener('storage', storage);
  };
}
