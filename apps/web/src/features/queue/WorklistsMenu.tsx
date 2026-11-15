import { editorName, itemFor } from '../navigation/catalog';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Popover } from '../../ui/Popover';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { loadWorklist, syncWorklists, useSavedWorklists } from './worklists';
import { draftItems, savedItems, worklistAvailable } from './savedSources';
import { startQueue } from './start';
import type { QueueItem } from './model';
import type { WorklistEntry } from '../../../../../packages/core/src/worklists';
import styles from './WorklistsMenu.module.scss';

export function WorklistsMenu() {
  return (
    <Popover label="Worklists" trigger="Worklists" className={styles.trigger} width={400}>
      {(close) => <WorklistsManager close={close} />}
    </Popover>
  );
}
export function AddToWorklist({
  items,
  className,
  label = 'Add to worklist',
}: {
  items: WorklistEntry[];
  className?: string;
  label?: string;
}) {
  const user = useAuthStore((state) => state.user);
  if (!user || !items.length) return null;
  return (
    <Popover
      label="Add to worklist"
      trigger={label}
      className={className ?? styles.trigger}
      width={320}
    >
      {(close) => <WorklistPicker items={items} close={close} />}
    </Popover>
  );
}
export function WorklistPicker({ items, close }: { items: WorklistEntry[]; close(): void }) {
  const lists = useSavedWorklists((state) => state.lists);
  const index = useSavedWorklists((state) => state.index);
  const loaded = useSavedWorklists((state) => state.loaded);
  const add = useSavedWorklists((state) => state.add);
  const [creating, setCreating] = useState(!lists.length);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const save = async (id: string | null) => {
    const attempt = ++request.current;
    try {
      if (id) await loadWorklist(id);
      if (attempt !== request.current) return;
      add(id, name, items);
      close();
    } catch (error) {
      if (attempt === request.current)
        setError(error instanceof Error ? error.message : 'Could not add entries.');
    }
  };
  return (
    <div className={styles.content}>
      <p>
        Add {items.length} {items.length === 1 ? 'entry' : 'entries'} to:
      </p>
      {lists.map((list) => (
        <button
          key={list.id}
          type="button"
          className={styles.choice}
          onClick={() => void save(list.id)}
        >
          <span>{list.name}</span>
          <span>{loaded.includes(list.id) ? list.items.length : (index[list.id]?.count ?? 0)}</span>
        </button>
      ))}
      {!creating ? (
        <button type="button" onClick={() => setCreating(true)}>
          New worklist…
        </button>
      ) : (
        <form
          className={styles.row}
          onSubmit={(event) => {
            event.preventDefault();
            void save(null);
          }}
        >
          <input
            autoFocus
            aria-label="New worklist name"
            placeholder="Worklist name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={!name.trim()}>
            Create
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function WorklistsManager({ close = () => {} }: { close?(restoreFocus?: boolean): void }) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const { lists, index, loaded, notice, pending, change } = useSavedWorklists();
  const [drafts, setDrafts] = useState<QueueItem[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!data) return;
    let live = true;
    void draftItems(data).then((items) => {
      if (live) setDrafts(items);
    });
    return () => {
      live = false;
    };
  }, [data]);
  const openRequest = useRef(0);
  useEffect(
    () => () => {
      openRequest.current++;
    },
    [location.key],
  );
  const run = async (items: QueueItem[], id?: string) => {
    const attempt = ++openRequest.current;
    if (id && data) {
      try {
        items = savedItems((await loadWorklist(id)).items, useDataStore.getState().data ?? data);
      } catch (error) {
        setError(String(error));
        return;
      }
    }
    if (attempt !== openRequest.current || !data || !items.length) return;
    const first = items.find((item) => worklistAvailable(item.hash, data));
    if (!first) {
      setError('Every entry is unavailable. Remove unavailable entries or choose another list.');
      return;
    }
    const target = startQueue({
      source: id ? 'custom' : 'drafts',
      scope: 'shown',
      items,
      first,
      origin: { path: `${location.pathname}${location.search}`, restore: { worklistId: id } },
      focus: true,
    });
    close(false);
    navigate(target.to, { state: target.state });
  };
  const update = (next: typeof lists) => {
    try {
      change(next);
      setError('');
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <div className={styles.content}>
      <button
        type="button"
        className={styles.choice}
        disabled={!drafts?.length}
        onClick={() => void run(drafts!)}
      >
        <span>Drafts</span>
        <span>{drafts === null ? 'Loading…' : drafts.length}</span>
      </button>
      <p>Bulk drafts without saved English text. Save English to finish an entry.</p>
      {!user && <p>Sign in to create and sync saved worklists.</p>}
      {lists.map((list) => (
        <details
          key={list.id}
          className={styles.list}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setExpanded((old) => ({ ...old, [list.id]: open }));
            if (open && !loaded.includes(list.id))
              void loadWorklist(list.id).catch((error) => setError(String(error)));
          }}
        >
          <summary>
            {list.name} ·{' '}
            {loaded.includes(list.id) ? list.items.length : (index[list.id]?.count ?? 0)}
          </summary>
          <div className={styles.row}>
            <button
              type="button"
              disabled={
                !data || !(loaded.includes(list.id) ? list.items.length : index[list.id]?.count)
              }
              onClick={() => void run(savedItems(list.items, data!), list.id)}
            >
              Open
            </button>
            <Rename
              name={list.name}
              disabled={!loaded.includes(list.id)}
              onSave={(name) =>
                update(lists.map((old) => (old.id === list.id ? { ...old, name } : old)))
              }
            />
            <Delete onDelete={() => update(lists.filter((old) => old.id !== list.id))} />
          </div>
          {expanded[list.id] && !loaded.includes(list.id) && !error && (
            <p role="status">Loading entries…</p>
          )}
          <ol className={styles.items}>
            {expanded[list.id] &&
              list.items.map((item) => (
                <li key={item.hash}>
                  <span>
                    {item.name ||
                      (data && itemFor(item.hash, data)
                        ? editorName(itemFor(item.hash, data)!)
                        : item.hash)}
                    {data && !worklistAvailable(item.hash, data) ? ' · Unavailable' : ''}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${item.name || (data && itemFor(item.hash, data) ? editorName(itemFor(item.hash, data)!) : item.hash)}`}
                    onClick={() =>
                      update(
                        lists.map((old) =>
                          old.id === list.id
                            ? {
                                ...old,
                                items: old.items.filter((entry) => entry.hash !== item.hash),
                              }
                            : old,
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ol>
        </details>
      ))}
      {user &&
        (!creating ? (
          <button type="button" onClick={() => setCreating(true)}>
            New worklist…
          </button>
        ) : (
          <form
            className={styles.row}
            onSubmit={(event) => {
              event.preventDefault();
              try {
                useSavedWorklists.getState().add(null, name, []);
                setName('');
                setCreating(false);
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            <input
              autoFocus
              aria-label="New worklist name"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" disabled={!name.trim()}>
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        ))}
      {user && (
        <div className={styles.row}>
          <span role="status">
            {notice || (pending ? 'Saving changes…' : 'Saved worklists sync to your account.')}
          </span>
          <button type="button" onClick={() => void syncWorklists()}>
            Sync
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Rename({
  name,
  onSave,
  disabled,
}: {
  name: string;
  onSave(name: string): void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  return editing ? (
    <form
      className={styles.row}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text.trim());
        setEditing(false);
      }}
    >
      <input
        autoFocus
        aria-label="Rename worklist"
        maxLength={80}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={!text.trim()}>
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setText(name);
        setEditing(true);
      }}
    >
      Rename
    </button>
  );
}
function Delete({ onDelete }: { onDelete(): void }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className={styles.row}>
      <span>Delete list?</span>
      <button type="button" onClick={onDelete}>
        Delete
      </button>
      <button type="button" onClick={() => setConfirm(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button type="button" onClick={() => setConfirm(true)}>
      Delete…
    </button>
  );
}

/** A running queue can outlive the cached entries after a cross-device index refresh. */
export function RemoveFromWorklist({
  id,
  hash,
  className,
  label = 'Remove',
  onRemoved,
}: {
  id: string;
  hash: number;
  className?: string;
  label?: string;
  onRemoved?(): void;
}) {
  const list = useSavedWorklists((state) => state.lists.find((list) => list.id === id));
  const loaded = useSavedWorklists((state) => state.loaded.includes(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!list || (loaded && !list.items.some((item) => item.hash === hash))) return null;
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const scope = useSavedWorklists.getState().scope;
      await loadWorklist(id);
      const state = useSavedWorklists.getState();
      if (state.scope !== scope) throw new Error('The account changed.');
      state.change(
        state.lists.map((list) =>
          list.id === id
            ? { ...list, items: list.items.filter((item) => item.hash !== hash) }
            : list,
        ),
      );
      onRemoved?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not remove this entry.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className={className ?? styles.trigger}
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? 'Removing…' : label}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
