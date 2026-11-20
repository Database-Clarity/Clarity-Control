import { useEffect, useRef, useState } from 'react';
import { maxMarkNoteChars } from '@clarity/core/marks';
import { apiUrl } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { Popover } from '../../ui/Popover';
import { When } from '../../ui/When';
import { noEntryMarks, useMarksStore } from './store';
import styles from './marks.module.scss';

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
  const saving = useRef(false);
  const allowed = !!apiUrl && (user?.role === 'editor' || user?.role === 'maintainer');
  useEffect(() => {
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
  useEffect(() => {
    if (type && !types.some((item) => item.id === type)) {
      setType('');
      setNote('');
    }
  }, [types, type]);
  function select(id: string) {
    setType(id);
    setNote(entries.find((entry) => entry.type === id)?.note ?? '');
  }
  async function save(remove: boolean) {
    if (!allowed || !type || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await useMarksStore
        .getState()
        .save(remove ? { action: 'unmark', hash, type } : { action: 'mark', hash, type, note });
      setType('');
      setNote('');
    } catch {
      /* The shared error includes an explicit reload path below. */
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
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
      <div className={styles.panel} data-entry-marks-popup>
        <strong>Entry marks</strong>
        {error && <p role="alert">{error}</p>}
        {!entries.length && <p>No marks on this entry.</p>}
        {entries.map((entry) => (
          <div key={entry.type} className={styles.detail}>
            <span className={styles.chip} data-colour={entry.colour}>
              {entry.label}
            </span>
            {entry.note && <p>{entry.note}</p>}
            <small>
              {accounts?.[entry.by]?.login ?? `GitHub user ${entry.by}`} ·{' '}
              <When value={entry.at} />
            </small>
            {allowed && (
              <button type="button" disabled={busy || !writable} onClick={() => select(entry.type)}>
                Edit mark
              </button>
            )}
          </div>
        ))}
        {allowed && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void useMarksStore.getState().reload()}
            >
              Reload marks
            </button>
            {!writable && !error && <p role="status">Loading current marks…</p>}
            {!types.length && writable && <p>A maintainer can create mark types in Management.</p>}
            {!!types.length && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(false);
                }}
              >
                <fieldset disabled={busy || !writable}>
                  <label>
                    Mark type
                    <select value={type} onChange={(event) => select(event.target.value)} required>
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
                      {busy ? 'Saving…' : 'Save mark'}
                    </button>
                    {entries.some((entry) => entry.type === type) && (
                      <button type="button" onClick={() => void save(true)}>
                        Remove mark
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
