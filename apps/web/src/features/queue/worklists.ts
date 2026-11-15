import { create } from 'zustand';
import { z } from 'zod';
import {
  storedWorklistSchema,
  worklistOperationSchema,
  worklistIndexEntrySchema,
  worklistsSchema,
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
type Meta = z.infer<typeof worklistIndexEntrySchema>;
interface Save {
  id: string;
  name: string;
  op: WorklistOperation;
}
interface State {
  scope: string;
  lists: SavedWorklist[];
  loaded: string[];
  index: Record<string, Meta>;
  saving: Save[];
  failed: Save[];
  notice: string;
  change(id: string, op: WorklistOperation): Promise<boolean>;
  add(id: string | null, name: string, items: WorklistEntry[]): Promise<boolean>;
}
const empty = () => ({ lists: [], loaded: [], index: {}, saving: [], failed: [], notice: '' });
let generation = 0;
let controller = new AbortController();
let chain: Promise<unknown> = Promise.resolve();
const cacheKey = (scope: string) => `clarity-worklists:v3:${scope}`;
const entryPath = (id: string) => `/worklists/${encodeURIComponent(id)}`;
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
function assertCurrent(started: number) {
  if (started !== generation || !accountReady()) throw new Error('The account changed.');
}
/** All reads and writes use this chain. Resetting an account aborts its entire chain. */
function serial<T>(work: (started: number) => Promise<T>): Promise<T> {
  const started = generation;
  const result = chain.then(() => {
    assertCurrent(started);
    return work(started);
  });
  chain = result.catch(() => {});
  return result;
}
async function request(path: string, started: number, init: RequestInit = {}) {
  assertCurrent(started);
  const response = await apiRequest(path, { ...init, signal: controller.signal });
  assertCurrent(started);
  return response;
}
function keepCache() {
  const { scope, lists, loaded, index } = useSavedWorklists.getState();
  try {
    localStorage.setItem(cacheKey(scope), JSON.stringify({ base: lists, loaded, index }));
  } catch {
    // A display cache is optional; saves only succeed with the server's acknowledgement.
  }
}
function accept(id: string, reply: z.infer<typeof replySchema>) {
  const state = useSavedWorklists.getState();
  const lists = state.lists.filter((row) => row.id !== id);
  const index = { ...state.index };
  if (reply.worklist && reply.revision) {
    lists.push({
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
  useSavedWorklists.setState({ lists, index, loaded: [...new Set([...state.loaded, id])] });
  keepCache();
}
async function readRow(id: string, started: number, apply = true) {
  const response = await request(entryPath(id), started);
  if (!response.ok) throw new Error('Could not load this worklist. Retry when connected.');
  const reply = replySchema.parse(await response.json());
  assertCurrent(started);
  if (apply) accept(id, reply);
  return reply;
}
async function readIndex(started: number) {
  const response = await request('/worklists', started);
  if (!response.ok) throw new Error('Could not read the worklist index.');
  const remote = indexSchema.parse(await response.json());
  assertCurrent(started);
  const state = useSavedWorklists.getState();
  const index = Object.fromEntries(remote.lists.map((meta) => [meta.id, meta]));
  const loaded = state.loaded.filter((id) => index[id]?.revision === state.index[id]?.revision);
  const lists = remote.lists.map(
    (meta) =>
      (loaded.includes(meta.id) && state.lists.find((row) => row.id === meta.id)) || {
        id: meta.id,
        name: meta.name,
        items: [],
      },
  );
  useSavedWorklists.setState({ lists, index, loaded, notice: '' });
  keepCache();
}
export function loadWorklist(id: string, authoritative = false): Promise<SavedWorklist> {
  return serial(async (started) => {
    const state = useSavedWorklists.getState();
    if (!state.lists.some((row) => row.id === id))
      throw new Error('The saved worklist was deleted.');
    if (authoritative || !state.loaded.includes(id)) await readRow(id, started);
    assertCurrent(started);
    const row = useSavedWorklists.getState().lists.find((row) => row.id === id);
    if (!row) throw new Error('This worklist was deleted on another device.');
    return row;
  });
}
/** Refresh never replays a failed save. Retry is a separate, explicit user action. */
export function syncWorklists(): Promise<void> {
  const started = generation;
  if (!accountReady()) return Promise.resolve();
  return serial(readIndex).catch((error: unknown) => {
    if (started === generation && accountReady())
      useSavedWorklists.setState({
        notice: error instanceof Error ? error.message : 'Refresh failed.',
      });
  });
}
function save(item: Save): Promise<boolean> {
  const started = generation;
  useSavedWorklists.setState((state) => ({ saving: [...state.saving, item] }));
  return serial(async () => {
    let revision: string | null = useSavedWorklists.getState().index[item.id]?.revision ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(entryPath(item.id), started, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: item.op, revision }),
      });
      if (response.status === 409 && attempt === 0) {
        // Refetch for CAS, but keep the visible last-saved row until this op succeeds.
        revision = (await readRow(item.id, started, false)).revision;
        continue;
      }
      if (!response.ok) throw new Error('Could not save this worklist.');
      const reply = replySchema.parse(await response.json());
      assertCurrent(started);
      if (!reply.worklist && item.op.type !== 'delete')
        throw new Error('This worklist was deleted.');
      accept(item.id, reply);
      return true;
    }
    return false;
  })
    .catch(() => {
      if (started === generation && accountReady())
        useSavedWorklists.setState((state) => ({ failed: [...state.failed, item] }));
      return false;
    })
    .then((success) => {
      if (started !== generation || !accountReady()) return false;
      useSavedWorklists.setState((state) => ({
        saving: state.saving.filter((save) => save !== item),
      }));
      if (success) void syncWorklists();
      return success;
    });
}
export function retryWorklist(item: Save): Promise<boolean> {
  const state = useSavedWorklists.getState();
  if (!state.failed.includes(item) || !accountReady()) return Promise.resolve(false);
  useSavedWorklists.setState({ failed: state.failed.filter((failed) => failed !== item) });
  return save(item);
}
function enqueue(id: string, op: WorklistOperation): Promise<boolean> {
  if (!accountReady()) throw new Error('Sign in to save worklists.');
  op = worklistOperationSchema.parse(op);
  const row = useSavedWorklists.getState().lists.find((row) => row.id === id);
  return save({ id, op, name: 'name' in op ? op.name : (row?.name ?? 'Worklist') });
}
export const useSavedWorklists = create<State>(() => ({
  scope: 'anonymous',
  ...empty(),
  change: enqueue,
  add(id, name, items): Promise<boolean> {
    if (id && !useSavedWorklists.getState().lists.some((row) => row.id === id))
      throw new Error('This worklist was deleted. Choose another worklist.');
    const hashes = [...new Set(items.map((item) => item.hash))];
    return enqueue(
      id ?? crypto.randomUUID(),
      id ? { type: 'add', hashes } : { type: 'create', name: name.trim(), hashes },
    );
  },
}));
export function connectWorklists(): () => void {
  let identity = '';
  const reset = () => {
    generation++;
    controller.abort();
    controller = new AbortController();
    chain = Promise.resolve();
  };
  const account = () => {
    const auth = useAuthStore.getState();
    const scope = String(auth.user?.id ?? 'anonymous');
    const next = JSON.stringify([scope, auth.token, auth.loading]);
    if (next === identity) return;
    identity = next;
    reset();
    useSavedWorklists.setState({ scope, ...empty() });
    if (!accountReady()) return;
    try {
      const cache = z
        .object({
          base: worklistsSchema,
          loaded: z.array(z.string()),
          index: z.record(z.string(), worklistIndexEntrySchema),
        })
        .parse(JSON.parse(localStorage.getItem(cacheKey(scope)) ?? 'null'));
      // Cached rows are only for display. The first open must read the server again.
      useSavedWorklists.setState({ lists: cache.base, index: cache.index });
    } catch {
      // An absent or unreadable display cache does not affect server state.
    }
    void syncWorklists();
  };
  const unsubscribe = useAuthStore.subscribe(account);
  account();
  const refresh = () => {
    if (document.visibilityState === 'visible') void syncWorklists();
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    unsubscribe();
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
    reset();
    useSavedWorklists.setState({ scope: 'anonymous', ...empty() });
  };
}
