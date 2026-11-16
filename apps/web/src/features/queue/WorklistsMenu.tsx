import { editorName, itemFor } from '../navigation/catalog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Popover } from '../../ui/Popover';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { usePreviewReviewStore } from '../../stores/previewReview';
import {
  loadWorklist,
  syncWorklists,
  useSavedWorklists,
  retryWorklist,
  type Save,
} from './worklists';
import { draftItems, savedItems, worklistAvailable } from './savedSources';
import { startQueue } from './start';
import { queueSources } from './sources';
import type { QueueItem } from './model';
import type {
  WorklistEntry,
  WorklistOperation,
  WorklistIndexEntry,
} from '../../../../../packages/core/src/worklists';
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
  label?: ReactNode;
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
  const saving = useSavedWorklists((state) => state.saving);
  const [creating, setCreating] = useState(!lists.length);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const save = async (id: string | null) => {
    if (busy) return;
    setBusy(true);
    const attempt = ++request.current;
    try {
      if (await add(id, name, items)) {
        if (attempt === request.current) close();
      }
    } catch (error) {
      if (attempt === request.current)
        setError(error instanceof Error ? error.message : 'Could not add entries.');
    } finally {
      if (attempt === request.current) setBusy(false);
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
          disabled={busy}
          onClick={() => void save(list.id)}
        >
          <span>
            {list.name}
            {saving.some((save) => save.id === list.id) ? ' · Saving…' : ''}
          </span>
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
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Create'}
          </button>
        </form>
      )}
      <WorklistSaveStatus show={(save) => save.op.type === 'add' || save.op.type === 'create'} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function WorklistsManager({ close = () => {} }: { close?(restoreFocus?: boolean): void }) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const { lists, index, loaded, notice, saving, change } = useSavedWorklists();
  const [drafts, setDrafts] = useState<QueueItem[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
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
    const source = id ? 'custom' : 'drafts';
    if (
      !usePreviewReviewStore
        .getState()
        .requestLeave(location.pathname, queueSources[source].path(first).split('?')[0]!)
    )
      return;
    const target = startQueue({
      source,
      scope: 'shown',
      items,
      first,
      origin: { path: `${location.pathname}${location.search}`, restore: { worklistId: id } },
      focus: true,
    });
    close(false);
    navigate(target.to, { state: target.state });
  };
  const update = (id: string, op: WorklistOperation) => {
    try {
      void change(id, op);
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
          }}
        >
          <summary>
            {list.name} ·{' '}
            {loaded.includes(list.id) ? list.items.length : (index[list.id]?.count ?? 0)}
            {saving.some((save) => save.id === list.id) && ' · Saving…'}
          </summary>
          {renaming === list.id ? (
            <Rename
              name={list.name}
              onSave={(name) => update(list.id, { type: 'rename', name })}
              onClose={() => setRenaming(null)}
            />
          ) : (
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
              <button
                type="button"
                disabled={!loaded.includes(list.id)}
                onClick={() => setRenaming(list.id)}
              >
                Rename
              </button>
              <Delete onDelete={() => update(list.id, { type: 'delete' })} />
            </div>
          )}
          {expanded[list.id] && !loaded.includes(list.id) && (
            <WorklistLoader id={list.id} meta={index[list.id]} />
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
                    onClick={() => update(list.id, { type: 'remove', hashes: [item.hash] })}
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
            {notice || (saving.length ? 'Saving…' : 'Saved worklists sync to your account.')}
          </span>
          <button type="button" onClick={() => void syncWorklists()}>
            Sync
          </button>
        </div>
      )}
      <WorklistSaveStatus />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
/** Each open list reloads when a refresh invalidates its saved row. */
function WorklistLoader({ id, meta }: { id: string; meta?: WorklistIndexEntry }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    void loadWorklist(id).catch((error) => {
      if (live) setError(String(error));
    });
    return () => {
      live = false;
    };
  }, [id, meta]);
  return <p role={error ? 'alert' : 'status'}>{error || 'Loading entries…'}</p>;
}
/** Replaces the list's action row while open, so the name field gets the whole width. */
function Rename({
  name,
  onSave,
  onClose,
}: {
  name: string;
  onSave(name: string): void;
  onClose(): void;
}) {
  const [text, setText] = useState(name);
  return (
    <form
      className={styles.edit}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text.trim());
        onClose();
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
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </form>
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
      const saved = await useSavedWorklists
        .getState()
        .change(id, { type: 'remove', hashes: [hash] });
      if (saved && useSavedWorklists.getState().scope === scope) onRemoved?.();
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
        {busy ? 'Saving…' : label}
      </button>
      <WorklistSaveStatus
        show={(save) =>
          save.id === id && save.op.type === 'remove' && save.op.hashes.includes(hash)
        }
      />
      {error && (
        <p role="alert" className={styles.failure}>
          {error}
        </p>
      )}
    </>
  );
}

function failure(save: Save): string {
  const { op, name } = save;
  const count = (hashes: number[]) =>
    hashes.length === 1 ? '1 entry' : `${hashes.length} entries`;
  switch (op.type) {
    case 'create':
      return `Couldn't create ${name}.`;
    case 'add':
      return `Couldn't add ${count(op.hashes)} to ${name}.`;
    case 'remove':
      return `Couldn't remove ${count(op.hashes)} from ${name}.`;
    case 'rename':
      return `Couldn't rename ${name} to ${op.name}.`;
    case 'delete':
      return `Couldn't delete ${name}.`;
    default:
      return `Couldn't save ${name}.`;
  }
}
/** Failed operations live only in this tab, and run again only on this button. Each place shows
 * the saves it started (Management shows all of them). */
function WorklistSaveStatus({ show = () => true }: { show?(save: Save): boolean }) {
  const failed = useSavedWorklists((state) => state.failed);
  const saving = useSavedWorklists((state) => state.saving);
  const lists = useSavedWorklists((state) => state.lists);
  return (
    <>
      {saving
        .filter((save) => show(save) && !lists.some((row) => row.id === save.id))
        .map((save, index) => (
          <p role="status" className={styles.saving} key={index}>
            {save.name}: Saving…
          </p>
        ))}
      {failed.filter(show).map((save, index) => (
        <p role="alert" className={styles.failure} key={index}>
          <span>{failure(save)}</span>
          <button type="button" onClick={() => void retryWorklist(save)}>
            Retry
          </button>
        </p>
      ))}
    </>
  );
}
