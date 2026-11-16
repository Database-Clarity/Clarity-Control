import { useEffect, useRef, useState } from 'react';
import { markColours, type MarkAction, type MarkType } from '@clarity/core/marks';
import { useAuthStore } from '../../stores/auth';
import { useMarksStore } from './store';
import styles from './marks.module.scss';

export function MarkTypes() {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const { marks, writable, error } = useMarksStore();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [colour, setColour] = useState<MarkType['colour']>('neutral');
  const [removing, setRemoving] = useState<string | null>(null);
  const saving = useRef(false);
  const allowed = user?.role === 'maintainer';
  useEffect(() => {
    setEditing(null);
    setLabel('');
    setRemoving(null);
    if (allowed) void useMarksStore.getState().reload();
  }, [allowed, user, token]);
  useEffect(() => {
    if (editing && !marks.types.some((type) => type.id === editing)) {
      setEditing(null);
      setLabel('');
    }
    if (removing && !marks.types.some((type) => type.id === removing)) setRemoving(null);
  }, [marks.types, editing, removing]);
  async function save(change: MarkAction) {
    if (!allowed || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await useMarksStore.getState().save(change);
      setEditing(null);
      setLabel('');
      setColour('neutral');
      setRemoving(null);
    } catch {
      /* Shared notice below explains conflicts and reload. */
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!allowed) return null;
  const removed = marks.types.find((type) => type.id === removing);
  return (
    <section className={`${styles.panel} ${styles.management}`} aria-label="Mark types">
      <h2>Mark types</h2>
      <p>Editors and maintainers can mark entries. Maintainers manage the available types.</p>
      {error && <p role="alert">{error}</p>}
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void useMarksStore.getState().reload()}
        >
          Reload mark types
        </button>
      </div>
      {!writable && !error && <p role="status">Loading mark types…</p>}
      {!marks.types.length && writable && <p>No mark types yet.</p>}
      {marks.types.map((type) => (
        <div key={type.id} className={styles.typeRow}>
          <span className={styles.chip} data-colour={type.colour}>
            {type.label}
          </span>
          <button
            type="button"
            aria-label={`Edit ${type.label}`}
            disabled={!writable || busy}
            onClick={() => {
              setEditing(type.id);
              setLabel(type.label);
              setColour(type.colour);
              setRemoving(null);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            aria-label={`Remove ${type.label}`}
            disabled={!writable || busy}
            onClick={() => setRemoving(type.id)}
          >
            Remove
          </button>
        </div>
      ))}
      {removed && (
        <div className={styles.detail} role="group" aria-label="Confirm mark type removal">
          <p>
            Remove “{removed.label}” and all its marks? This affects{' '}
            {
              Object.values(marks.entries).filter((entries) =>
                entries.some((entry) => entry.type === removed.id),
              ).length
            }{' '}
            entries.
          </p>
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel removal
            </button>
            <button
              type="button"
              disabled={busy || !writable}
              onClick={() => void save({ action: 'remove-type', id: removed.id, force: true })}
            >
              Remove type and marks
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(
            editing
              ? { action: 'edit-type', id: editing, label, colour }
              : { action: 'create-type', id: `mark-${crypto.randomUUID()}`, label, colour },
          );
        }}
      >
        <fieldset disabled={busy || !writable}>
          <div className={styles.typeRow}>
            <label>
              Type name
              <input
                required
                maxLength={64}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              Colour
              <select
                value={colour}
                onChange={(event) => setColour(event.target.value as MarkType['colour'])}
              >
                {markColours.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.actions}>
            <button type="submit" disabled={!label.trim()}>
              {busy ? 'Saving…' : editing ? 'Save type' : 'Create type'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setLabel('');
                  setColour('neutral');
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}
