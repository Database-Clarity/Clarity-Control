import { sessionToken } from '../../services/session';
import { create } from 'zustand';
import { z } from 'zod';
import {
  mergeWorklists,
  recoveredWorklistsSchema,
  worklistsSchema,
  storedWorklistSchema,
  worklistIndexEntrySchema,
  type SavedWorklist,
  type WorklistEntry,
} from '../../../../../packages/core/src/worklists';
import { apiRequest } from '../../services/apiAuth';
import { useAuthStore } from '../../stores/auth';

const replySchema = z.object({
  worklist: storedWorklistSchema.extend({ id: z.string().uuid() }).nullable(),
  revision: z.string().nullable(),
});
const indexSchema = z.object({ lists: z.array(worklistIndexEntrySchema).max(50) });
const copySchema = z.object({
  lists: recoveredWorklistsSchema,
  dirty: z.array(z.string()),
  removed: z.record(z.string(), z.string()),
  loaded: z.array(z.string()),
  index: z.record(z.string(), worklistIndexEntrySchema),
});
type Copy = z.infer<typeof copySchema>;
const empty = (): Copy => ({ lists: [], dirty: [], removed: {}, loaded: [], index: {} });
const key = (scope: string) => `clarity-worklists:v2:${scope}`;
interface State extends Copy {
  scope: string;
  pending: boolean;
  notice: string;
  change(lists: SavedWorklist[]): void;
  add(id: string | null, name: string, items: WorklistEntry[]): void;
}
let epoch = 0;
let flight = false;
let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function accountReady(): boolean {
  const auth = useAuthStore.getState();
  if (auth.loading || !auth.user || String(auth.user.id) !== useSavedWorklists.getState().scope)
    return false;
  try {
    return auth.token === null || auth.token === sessionToken();
  } catch {
    return false;
  }
}
function persist() {
  const { scope, lists, dirty, removed, loaded, index } = useSavedWorklists.getState();
  if (scope === 'anonymous') return;
  try {
    localStorage.setItem(key(scope), JSON.stringify({ lists, dirty, removed, loaded, index }));
  } catch {
    useSavedWorklists.setState({
      notice: 'Browser storage is unavailable. Keep this tab open until account sync succeeds.',
    });
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void syncWorklists(), 600);
}
function changed(copy: Partial<Copy>) {
  useSavedWorklists.setState(copy);
  const state = useSavedWorklists.getState();
  useSavedWorklists.setState({
    pending: state.dirty.length > 0 || Object.keys(state.removed).length > 0,
  });
  persist();
}
export const useSavedWorklists = create<State>((set, get) => ({
  scope: 'anonymous',
  ...empty(),
  pending: false,
  notice: '',
  change(lists) {
    const current = get();
    if (current.scope === 'anonymous') throw new Error('Sign in to save worklists.');
    const size = (value: SavedWorklist[]) =>
      value.length + value.reduce((total, list) => total + list.items.length, 0);
    const reducingRecovery =
      !worklistsSchema.safeParse(current.lists).success &&
      recoveredWorklistsSchema.safeParse(lists).success &&
      size(lists) < size(current.lists);
    if (!worklistsSchema.safeParse(lists).success && !reducingRecovery)
      throw new Error(
        'Worklists allow up to 50 lists, 500 entries and 16 KB of hashes per list, and names of 1–80 characters.',
      );
    const old = new Map(current.lists.map((list) => [list.id, list]));
    const modified = lists.filter((list) => !same(list, old.get(list.id))).map((list) => list.id);
    if (modified.some((id) => old.has(id) && !current.loaded.includes(id)))
      throw new Error('Open this worklist to load its entries first.');
    const kept = new Set(lists.map((list) => list.id));
    const removed = { ...current.removed };
    for (const list of current.lists)
      if (!kept.has(list.id) && current.index[list.id])
        removed[list.id] = current.index[list.id]!.revision;
    for (const id of kept) delete removed[id];
    set({ notice: 'Saving changes…' });
    changed({
      lists,
      dirty: [...new Set([...current.dirty.filter((id) => kept.has(id)), ...modified])],
      removed,
      loaded: [...new Set([...current.loaded.filter((id) => kept.has(id)), ...modified])],
    });
    schedule();
  },
  add(id, name, items) {
    const lists = get().lists;
    const list = lists.find((list) => list.id === id);
    if (id && !list) throw new Error('This worklist was deleted. Choose another worklist.');
    const hashes = new Set(list?.items.map((item) => item.hash));
    const added = items
      .filter((item) => {
        if (hashes.has(item.hash)) return false;
        hashes.add(item.hash);
        return true;
      })
      .map(({ hash, name }) => ({ hash, name: name.slice(0, 160) }));
    get().change(
      list
        ? lists.map((old) => (old === list ? { ...old, items: [...old.items, ...added] } : old))
        : [...lists, { id: crypto.randomUUID(), name: name.trim(), items: added }],
    );
  },
}));
const entryPath = (id: string) => `/worklists/${encodeURIComponent(id)}`;
const unpack = (remote: NonNullable<z.infer<typeof replySchema>['worklist']>): SavedWorklist => ({
  id: remote.id,
  name: remote.name,
  items: remote.hashes.map((hash) => ({ hash, name: '' })),
});

/** Reads only this list. Locally loaded entries remain usable offline. */
export async function loadWorklist(id: string): Promise<SavedWorklist> {
  const state = useSavedWorklists.getState();
  const existing = state.lists.find((list) => list.id === id);
  if (!existing) throw new Error('The saved worklist was deleted. This run keeps its items.');
  if (state.loaded.includes(id)) return existing;
  if (!accountReady()) throw new Error('Wait for this account to finish signing in.');
  const started = epoch;
  const response = await apiRequest(entryPath(id));
  if (!response.ok) throw new Error('Could not load this worklist. Retry when connected.');
  const remote = replySchema.parse(await response.json());
  if (started !== epoch || !accountReady()) throw new Error('The account changed.');
  if (!remote.worklist || !remote.revision)
    throw new Error('This worklist was deleted on another device. Sync to update the index.');
  const current = useSavedWorklists.getState();
  const local = current.lists.find((list) => list.id === id);
  if (!local) throw new Error('This worklist was deleted while loading.');
  if (current.loaded.includes(id) && current.index[id]?.revision !== state.index[id]?.revision)
    return local;
  const list =
    current.dirty.includes(id) && local
      ? mergeWorklists([local], [unpack(remote.worklist)])[0]!
      : unpack(remote.worklist);
  changed({
    lists: current.lists.some((list) => list.id === id)
      ? current.lists.map((old) => (old.id === id ? list : old))
      : [...current.lists, list],
    loaded: [...new Set([...current.loaded, id])],
    index: {
      ...current.index,
      [id]: {
        id,
        name: remote.worklist.name,
        count: remote.worklist.hashes.length,
        updatedAt: current.index[id]?.updatedAt ?? 0,
        revision: remote.revision,
      },
    },
  });
  return list;
}

/** Metadata-only index, and at most one changed-list write in flight. */
export async function syncWorklists() {
  if (flight || !accountReady()) return;
  flight = true;
  const started = epoch;
  try {
    if (!ready) {
      const before = useSavedWorklists.getState().index;
      const response = await apiRequest('/worklists');
      if (!response.ok) throw new Error('Could not read the worklist index.');
      const remote = indexSchema.parse(await response.json());
      if (started !== epoch || !accountReady()) return;
      const current = useSavedWorklists.getState();
      const lists = [...current.lists];
      const index = { ...current.index };
      const loaded = new Set(current.loaded);
      const ids = new Set(remote.lists.map((list) => list.id));
      for (const meta of remote.lists) {
        if (current.removed[meta.id]) continue;
        const position = lists.findIndex((list) => list.id === meta.id);
        // A list loaded or saved after this index request has the more recent revision.
        if (index[meta.id]?.revision !== before[meta.id]?.revision) continue;
        if (!current.dirty.includes(meta.id)) {
          const local = position >= 0 ? lists[position] : undefined;
          const cached = loaded.has(meta.id) && index[meta.id]?.revision === meta.revision;
          const list = { id: meta.id, name: meta.name, items: cached ? (local?.items ?? []) : [] };
          if (!cached) loaded.delete(meta.id);
          if (position >= 0) lists[position] = list;
          else lists.push(list);
        }
        // Pending edits retain their base revision, so CAS detects remote additions.
        if (!current.dirty.includes(meta.id)) index[meta.id] = meta;
      }
      const kept = lists.filter((list) => ids.has(list.id) || current.dirty.includes(list.id));
      const retained = new Set([...kept.map((list) => list.id), ...Object.keys(current.removed)]);
      for (const id of Object.keys(index)) if (!retained.has(id)) delete index[id];
      changed({ lists: kept, index, loaded: [...loaded].filter((id) => retained.has(id)) });
      ready = true;
    }
    let current = useSavedWorklists.getState();
    const removedId = Object.keys(current.removed)[0];
    const id = removedId ?? current.dirty[0];
    if (!id) return;
    const list = current.lists.find((list) => list.id === id);
    if (!removedId && (!list || !worklistsSchema.safeParse([list]).success))
      throw new Error(
        'Merged worklist exceeds 500 entries or 16 KB. Remove entries to sync; all entries remain in this tab.',
      );
    const response = await apiRequest(entryPath(id), {
      method: removedId ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        removedId
          ? { revision: current.removed[id] }
          : {
              name: list!.name,
              hashes: list!.items.map((item) => item.hash),
              revision: current.index[id]?.revision ?? null,
            },
      ),
    });
    if (started !== epoch || !accountReady()) return;
    if (!response.ok && response.status !== 409)
      throw new Error('Could not sync this worklist. The account allows up to 50 lists.');
    const remote = replySchema.parse(await response.json());
    if (started !== epoch || !accountReady()) return;
    current = useSavedWorklists.getState();
    const removed = { ...current.removed };
    delete removed[id];
    const index = { ...current.index };
    if (response.status === 409) {
      const recovered = remote.worklist ? unpack(remote.worklist) : null;
      if (recovered && remote.revision)
        index[id] = {
          id,
          name: recovered.name,
          count: recovered.items.length,
          updatedAt: Date.now(),
          revision: remote.revision,
        };
      else delete index[id];
      changed({
        lists: recovered ? mergeWorklists(current.lists, [recovered]) : current.lists,
        index,
        removed,
        dirty: [...new Set([...current.dirty, ...(recovered || list ? [id] : [])])],
        loaded: [...new Set([...current.loaded, ...(recovered ? [id] : [])])],
      });
      useSavedWorklists.setState({
        notice:
          'Merged changes from another device. Concurrent removals may reappear; all entries were kept.',
      });
    } else if (removedId) {
      delete index[id];
      changed({ index, removed });
    } else if (remote.revision && list) {
      index[id] = {
        id,
        name: list.name,
        count: list.items.length,
        updatedAt: Date.now(),
        revision: remote.revision,
      };
      const latest = current.lists.find((entry) => entry.id === id);
      // A list deleted while its create was in flight still needs a conditional delete.
      if (!latest) removed[id] = remote.revision;
      changed({
        index,
        removed,
        dirty:
          same(latest, list) || !latest
            ? current.dirty.filter((entry) => entry !== id)
            : current.dirty,
      });
    }
    if (useSavedWorklists.getState().pending) schedule();
    else if (!useSavedWorklists.getState().notice.includes('Concurrent removals'))
      useSavedWorklists.setState({ notice: 'Saved to your account.' });
  } catch (error) {
    if (started === epoch)
      useSavedWorklists.setState({
        notice: `${error instanceof Error ? error.message : 'Sync failed.'} Your local copy is kept. Retry when connected.`,
      });
  } finally {
    flight = false;
    if (started !== epoch) schedule();
  }
}
export function connectWorklists(): () => void {
  let checking = useAuthStore.getState().loading;
  const account = () => {
    if (useAuthStore.getState().loading) {
      if (!checking) {
        epoch++;
        ready = false;
      }
      checking = true;
      return;
    }
    const checked = checking;
    if (checking) {
      epoch++;
      ready = false;
      checking = false;
    }
    const scope = String(useAuthStore.getState().user?.id ?? 'anonymous');
    if (scope === useSavedWorklists.getState().scope) {
      if (checked) void syncWorklists();
      return;
    }
    epoch++;
    ready = false;
    clearTimeout(timer);
    let copy = empty();
    try {
      const parsed = copySchema.safeParse(JSON.parse(localStorage.getItem(key(scope)) ?? 'null'));
      if (parsed.success) copy = parsed.data;
    } catch {
      /* Keep unreadable copies until the account is read. */
    }
    useSavedWorklists.setState({
      scope,
      ...copy,
      pending: copy.dirty.length > 0 || Object.keys(copy.removed).length > 0,
      notice: '',
    });
    void syncWorklists();
  };
  const unsubscribe = useAuthStore.subscribe(account);
  account();
  const retry = () => {
    ready = false;
    void syncWorklists();
  };
  const storage = (event: StorageEvent) => {
    const current = useSavedWorklists.getState();
    if (event.key !== key(current.scope) || !event.newValue) return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const copy = copySchema.safeParse(raw);
    if (!copy.success) return;
    if (!current.pending) changed(copy.data);
    else {
      const lists = [...current.lists];
      for (const list of copy.data.lists) {
        const at = lists.findIndex((old) => old.id === list.id);
        if (at < 0) lists.push(list);
        else if (current.dirty.includes(list.id))
          lists[at] = mergeWorklists([lists[at]!], [list])[0]!;
        else lists[at] = list;
      }
      changed({
        lists,
        dirty: [...new Set([...current.dirty, ...copy.data.dirty])],
        loaded: [...new Set([...current.loaded, ...copy.data.loaded])],
        removed: { ...copy.data.removed, ...current.removed },
        index: { ...copy.data.index, ...current.index },
      });
      useSavedWorklists.setState({
        notice:
          'Merged another tab’s changes. Concurrent removals may reappear; all entries were kept.',
      });
    }
    ready = false;
    schedule();
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
