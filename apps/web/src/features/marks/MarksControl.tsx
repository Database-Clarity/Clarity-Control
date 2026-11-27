import { useEffect, useRef, useState } from 'react';
import { maxMarkNoteChars, type MarkAction } from '@clarity/core/marks';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { Popover } from '../../ui/Popover';
import { When } from '../../ui/When';
import { noEntryMarks, useMarksStore, type MarkDisplay } from './store';
import styles from './marks.module.scss';

/** Whether the header shows the entry's marks: for who can mark it, or if it has any. */
export function useMarksShown(hash: number | undefined): boolean {
  const role = useAuthStore((state) => state.user?.role);
  const marked = useMarksStore(
    (state) => !!state.error || (hash !== undefined && !!state.index.get(hash)?.length),
  );
  const allowed = !!apiUrl && (role === 'editor' || role === 'maintainer');
  return hash !== undefined && (allowed || marked);
}

/** A mark resolved while the popover is open: kept in its place with Undo until it closes. */
interface Resolved {
  mark: MarkDisplay;
  /** Its place in the list as shown when it was resolved. */
  index: number;
  /** Why Undo failed. */
  failed?: string;
}

/** Mark details and editing for the current entry in the editor header. */
export function MarksControl({
  hash,
  className,
  compact = false,
}: {
  hash: number;
  className?: string;
  compact?: boolean;
}) {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const accounts = useDataStore((state) => state.data?.bundle.permissions.users);
  const entries = useMarksStore((state) => state.index.get(hash) ?? noEntryMarks);
  const types = useMarksStore((state) => state.marks.types);
  const writable = useMarksStore((state) => state.writable);
  const error = useMarksStore((state) => state.error);
  const [open, setOpen] = useState(false);
  const identity = useRef({ hash, user, token });
  const [type, setType] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** Which row's write is running ("resolve:<type>", "undo:<type>"), for its label. */
  const [pending, setPending] = useState('');
  const [adding, setAdding] = useState(false);
  const [resolved, setResolved] = useState<Resolved[]>([]);
  const [failed, setFailed] = useState<{ type: string; message: string } | null>(null);
  /** The control that takes focus after a row changes ("undo:<type>", "resolve:<type>"). */
  const [focus, setFocus] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const saving = useRef(false);
  /**
   * Bumped when the popover closes or the entry or account changes: a write that finishes after
   * that changes nothing here (no Undo revived, no focus taken in a later popover).
   */
  const session = useRef(0);
  /** What opened the form ("add", "edit:<type>"): Cancel puts focus back there. */
  const opener = useRef('add');
  const allowed = !!apiUrl && (user?.role === 'editor' || user?.role === 'maintainer');
  useEffect(() => {
    session.current++;
    const previous = identity.current;
    identity.current = { hash, user, token };
    if (previous.hash !== hash || previous.user !== user || previous.token !== token) {
      setOpen(false);
    }
    setType('');
    setNote('');
  }, [hash, user, token]);
  useEffect(() => {
    if (open && allowed) void useMarksStore.getState().reload();
  }, [open, allowed, token]);
  // Closing forgets what was resolved (Undo is for while the popover is open) and folds the form.
  useEffect(() => {
    if (open) return;
    session.current++;
    setResolved([]);
    setFailed(null);
    setAdding(false);
  }, [open, hash]);
  useEffect(() => {
    if (type && !types.some((item) => item.id === type)) {
      setType('');
      setNote('');
    }
  }, [types, type]);
  useEffect(() => {
    if (!focus) return;
    setFocus('');
    for (const element of panel.current?.querySelectorAll<HTMLElement>('[data-focus]') ?? [])
      if (element.dataset.focus === focus) element.focus();
  }, [focus]);
  function select(id: string) {
    setType(id);
    setNote(entries.find((entry) => entry.type === id)?.note ?? '');
  }
  /** One write at a time; resolves to why it failed, or null. */
  async function write(change: MarkAction, row = ''): Promise<string | null> {
    if (saving.current) return 'Another change is saving.';
    saving.current = true;
    setBusy(true);
    setPending(row);
    try {
      await useMarksStore.getState().save(change);
      return null;
    } catch (reason) {
      return errorMessage(reason);
    } finally {
      saving.current = false;
      setBusy(false);
      setPending('');
    }
  }
  async function save(remove: boolean) {
    if (!allowed || !type) return;
    const at = session.current;
    const failure = await write(
      remove ? { action: 'unmark', hash, type } : { action: 'mark', hash, type, note },
    );
    // A failure keeps the form; the shared error says why and offers the reload.
    if (failure || at !== session.current) return;
    setType('');
    setNote('');
    setAdding(false);
    setFocus(remove ? 'add' : `resolve:${type}`);
  }
  /** `index`: the row's place in the list as shown, where its Undo stays. */
  async function resolve(mark: MarkDisplay, index: number) {
    if (!allowed) return;
    setFailed(null);
    const at = session.current;
    const failure = await write(
      { action: 'unmark', hash, type: mark.type },
      `resolve:${mark.type}`,
    );
    if (at !== session.current) return;
    if (failure) {
      setFailed({ type: mark.type, message: failure });
      return;
    }
    if (type === mark.type) {
      setType('');
      setNote('');
    }
    setResolved((list) => [
      ...list.filter((item) => item.mark.type !== mark.type),
      { mark, index },
    ]);
    setFocus(`undo:${mark.type}`);
  }
  async function undo(item: Resolved) {
    if (!allowed) return;
    const { type: id, note: kept } = item.mark;
    const at = session.current;
    const failure = await write({ action: 'mark', hash, type: id, note: kept }, `undo:${id}`);
    if (at !== session.current) return;
    setResolved((list) =>
      failure
        ? list.map((entry) => (entry.mark.type === id ? { ...entry, failed: failure } : entry))
        : list.filter((entry) => entry.mark.type !== id),
    );
    if (!failure) setFocus(`resolve:${id}`);
  }
  async function reload() {
    setFailed(null);
    setResolved((list) => list.map((item) => ({ ...item, failed: undefined })));
    await useMarksStore.getState().reload();
  }
  // A mark that is back (Undo, or marked again elsewhere) shows as a mark.
  const shownResolved = resolved
    .filter((item) => !entries.some((entry) => entry.type === item.mark.type))
    .sort((a, b) => a.index - b.index);
  // Each resolved mark goes back to where it was shown (in order, so earlier places hold).
  const rows: { mark: MarkDisplay; resolved?: Resolved }[] = entries.map((mark) => ({ mark }));
  for (const item of shownResolved)
    rows.splice(Math.min(item.index, rows.length), 0, { mark: item.mark, resolved: item });
  // A row's own failure says why there; the shared alert would repeat it.
  const rowFailure = !!failed || shownResolved.some((item) => item.failed);
  const formShown = adding || !!type || (!entries.length && !shownResolved.length);
  useEffect(() => {
    if (adding) picker.current?.focus();
  }, [adding]);
  if (!allowed && !entries.length && !error) return null;
  return (
    <Popover
      label="Entry marks"
      triggerLabel="Entry marks"
      className={`${className ?? ''} ${styles.control}`}
      trigger={
        <span className={styles.trigger}>
          {error
            ? 'Marks unavailable'
            : compact || !entries.length
              ? 'Marks'
              : entries.slice(0, 2).map((entry) => (
                  <span key={entry.type} className={styles.chip} data-colour={entry.colour}>
                    {entry.label}
                  </span>
                ))}
          {entries.length && (compact || entries.length > 2) ? ` (${entries.length})` : null}
        </span>
      }
      open={open}
      onOpenChange={setOpen}
      contain
      width={360}
    >
      <div ref={panel} className={styles.panel} data-entry-marks-popup>
        <strong>Entry marks</strong>
        {error && !rowFailure && <p role="alert">{error}</p>}
        {!rows.length && <p>No marks on this entry.</p>}
        {rows.map((row, position) =>
          row.resolved ? (
            <div key={row.mark.type} className={styles.detail} data-resolved>
              <span className={styles.resolvedLine}>
                <span className={styles.chip} data-colour={row.mark.colour}>
                  {row.mark.label}
                </span>
                <span role="status">Resolved</span>
                <button
                  type="button"
                  data-focus={`undo:${row.mark.type}`}
                  aria-label={`Undo: restore ${row.mark.label}`}
                  disabled={busy || !writable}
                  onClick={() => void undo(row.resolved!)}
                >
                  {pending === `undo:${row.mark.type}` ? 'Restoring…' : 'Undo'}
                </button>
              </span>
              {row.resolved.failed && <p role="alert">Not restored: {row.resolved.failed}</p>}
            </div>
          ) : (
            <div key={row.mark.type} className={styles.detail}>
              <span className={styles.chip} data-colour={row.mark.colour}>
                {row.mark.label}
              </span>
              {row.mark.note && <p>{row.mark.note}</p>}
              <small>
                {accounts?.[row.mark.by]?.login ?? `GitHub user ${row.mark.by}`} ·{' '}
                <When value={row.mark.at} />
              </small>
              {allowed && (
                <span className={styles.actions}>
                  <button
                    type="button"
                    data-focus={`resolve:${row.mark.type}`}
                    aria-label={`Resolve ${row.mark.label}`}
                    title="Remove this mark (Undo stays here while this is open)"
                    disabled={busy || !writable}
                    onClick={() => void resolve(row.mark, position)}
                  >
                    {pending === `resolve:${row.mark.type}` ? 'Resolving…' : 'Resolve'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !writable}
                    data-focus={`edit:${row.mark.type}`}
                    onClick={() => {
                      opener.current = `edit:${row.mark.type}`;
                      select(row.mark.type);
                    }}
                  >
                    Edit mark
                  </button>
                </span>
              )}
              {failed?.type === row.mark.type && <p role="alert">Not resolved: {failed.message}</p>}
            </div>
          ),
        )}
        {allowed && (
          <>
            <span className={styles.actions}>
              {!formShown && !!types.length && (
                <button
                  type="button"
                  data-focus="add"
                  disabled={busy || !writable}
                  onClick={() => {
                    opener.current = 'add';
                    setAdding(true);
                  }}
                >
                  Add mark
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void reload()}>
                Reload marks
              </button>
            </span>
            {!writable && !error && <p role="status">Loading current marks…</p>}
            {!types.length && writable && <p>A maintainer can create mark types in Management.</p>}
            {!!types.length && formShown && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(false);
                }}
              >
                <fieldset disabled={busy || !writable}>
                  <label>
                    Mark type
                    <select
                      ref={picker}
                      value={type}
                      onChange={(event) => select(event.target.value)}
                      required
                    >
                      <option value="">Choose a type</option>
                      {types.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Optional note
                    <textarea
                      maxLength={maxMarkNoteChars}
                      rows={3}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <div className={styles.actions}>
                    <button type="submit" disabled={!type}>
                      {busy && !pending ? 'Saving…' : 'Save mark'}
                    </button>
                    {entries.some((entry) => entry.type === type) && (
                      <button type="button" onClick={() => void save(true)}>
                        Remove mark
                      </button>
                    )}
                    {(entries.length > 0 || shownResolved.length > 0) && (
                      <button
                        type="button"
                        onClick={() => {
                          setAdding(false);
                          setType('');
                          setNote('');
                          setFocus(opener.current);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </fieldset>
              </form>
            )}
          </>
        )}
        {!allowed && <p>Marks are read-only.</p>}
      </div>
    </Popover>
  );
}
