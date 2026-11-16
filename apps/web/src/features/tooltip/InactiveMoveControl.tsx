import { useEffect, useRef, useState, type RefObject } from 'react';
import { isMovedInactive, type InactiveMoves } from '@clarity/core';
import { apiUrl } from '../../services/api';
import {
  getInactiveMoves,
  putInactiveMove,
  type LoadedInactiveMoves,
} from '../../services/inactiveMoves';
import { useAuthStore } from '../../stores/auth';
import { Popover } from '../../ui/Popover';
import styles from './InactiveMoveControl.module.scss';

/** Focus the explanation first; confirming requires navigating to the Move button. */
export function InactiveMoveControl({
  hash,
  name,
  moves,
  onSaved,
  className,
  compact = false,
}: {
  hash: number;
  name: string;
  moves?: InactiveMoves;
  onSaved(moves: InactiveMoves): void;
  className?: string;
  compact?: boolean;
}) {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const [open, setOpen] = useState(false);
  const explanation = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LoadedInactiveMoves | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const moved = isMovedInactive(hash, loaded?.moves ?? moves);
  const confirmationName = name.trim() || `Tooltip ${hash}`;
  const allowed = !!apiUrl && user?.role === 'maintainer' && (hash < 1 || hash > 3);
  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!open || !allowed) return;
    const abort = new AbortController();
    void getInactiveMoves(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setLoaded(value);
      },
      (reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Cannot load inactive moves');
      },
    );
    return () => abort.abort();
  }, [open, allowed, hash, token]);
  useEffect(() => {
    setOpen(false);
  }, [hash, user, token]);
  useEffect(() => {
    if (open) explanation.current?.focus();
  }, [open]);
  const save = async () => {
    if (!allowed || !loaded || savingRef.current) return;
    const identity = useAuthStore.getState();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await putInactiveMove(hash, !moved, loaded.revision);
      const current = useAuthStore.getState();
      if (current.user !== identity.user || current.token !== identity.token) return;
      onSaved(result.moves);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Cannot save inactive move');
      // A conflict requires closing and reopening for a fresh revision and confirmation.
      setLoaded(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  if (!allowed) return null;
  return (
    <Popover
      label={moved ? 'Move out of Inactive' : 'Move to Inactive'}
      trigger={
        compact ? (
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="6" />
            <path d={moved ? 'M4.5 8h7M8 4.5v7' : 'M4.5 8h7'} />
          </svg>
        ) : moved ? (
          'Move out of Inactive'
        ) : (
          'Move to Inactive'
        )
      }
      triggerLabel={moved ? 'Move out of Inactive' : 'Move to Inactive'}
      triggerTitle={moved ? 'Move out of Inactive' : 'Move to Inactive'}
      open={open}
      onOpenChange={setOpen}
      contain
      width={360}
      className={[className, moved && styles.moved].filter(Boolean).join(' ')}
    >
      {(close) => (
        <InactiveMoveConfirm
          moved={moved}
          name={confirmationName}
          loaded={!!loaded}
          saving={saving}
          error={error}
          focusRef={explanation}
          onCancel={() => close()}
          onMove={() => {
            void save();
          }}
        />
      )}
    </Popover>
  );
}

/**
 * The deliberate Move confirm: what moving changes, then Cancel and Move. Move stays disabled until
 * the current moves have loaded (a fresh revision) and while a save runs. Presentational only, so
 * the UI gallery can show it without a server.
 */
export function InactiveMoveConfirm({
  moved,
  name,
  loaded,
  saving,
  error,
  focusRef,
  onCancel,
  onMove,
}: {
  moved: boolean;
  /** The tooltip's name, or `Tooltip <hash>`. */
  name: string;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  focusRef?: RefObject<HTMLDivElement>;
  onCancel(): void;
  onMove(): void;
}) {
  return (
    <div className={styles.confirm} ref={focusRef} tabIndex={-1}>
      <strong>
        {moved ? 'Resume exporting' : 'Stop exporting'} {name}?
      </strong>
      <p>
        {moved
          ? 'Its computed category returns immediately. Its text returns to every output on the next publish of this row.'
          : 'It moves to Inactive & Placeholders immediately. Its text leaves every output (including DIM, light.gg, and clarityV2) on the next publish of this row. Its alias stubs are removed too. Text stays editable here.'}
      </p>
      <p>Importers must stop reading its text, or move to Inactive too, before publishing.</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error.replace(/[.!?]?$/, '.')} Close and reopen to reload, then try again.
        </p>
      )}
      {!loaded && !error && <p role="status">Loading current moves…</p>}
      <div className={styles.actions}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={!loaded || saving} onClick={onMove}>
          {saving ? 'Saving…' : 'Move'}
        </button>
      </div>
    </div>
  );
}
