import { useEffect, useRef, useState } from 'react';
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

/** A deliberate, typed confirmation. Only Cancel gets automatic focus from Popover. */
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
  const [typed, setTyped] = useState('');
  const [loaded, setLoaded] = useState<LoadedInactiveMoves | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const moved = isMovedInactive(hash, loaded?.moves ?? moves);
  const confirmationName = name.trim() || `Tooltip ${hash}`;
  const allowed = !!apiUrl && user?.role === 'maintainer';
  useEffect(() => {
    setTyped('');
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
  const save = async () => {
    if (!allowed || !loaded || typed !== confirmationName || savingRef.current) return;
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
      setTyped('');
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
            <path d="M4.5 8h7" />
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
      className={className}
    >
      {(close) => (
        <div className={styles.confirm}>
          <strong>
            {moved ? 'Resume exporting' : 'Stop exporting'} {confirmationName}?
          </strong>
          <p>
            {moved
              ? 'Its computed category returns immediately. Its text returns to every output on the next publish of this row.'
              : 'It moves to Inactive & Placeholders immediately. Its text leaves DIM, light.gg, all seven legacy outputs, and clarityV2 on the next publish of this row. Its alias stubs are removed too. Text stays editable here.'}
          </p>
          <p>Importers must stop reading its text, or move to Inactive too, before publishing.</p>
          <label>
            Type “{confirmationName}” to continue
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={!loaded || saving}
              onPaste={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </label>
          {error && <p role="alert">{error} Close and reopen to reload, then try again.</p>}
          {!loaded && !error && <p role="status">Loading current moves…</p>}
          <div className={styles.actions}>
            <button type="button" data-autofocus onClick={() => close()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!loaded || typed !== confirmationName || saving}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
              }}
              onClick={() => {
                void save();
              }}
            >
              {saving ? 'Saving…' : moved ? 'Resume exporting' : 'Stop exporting'}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
