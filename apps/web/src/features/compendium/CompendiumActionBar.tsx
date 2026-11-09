import { advanceChoices, useAdvanceSetting } from './advanceSetting';
import styles from './CompendiumTab.module.scss';

export interface ActionBarProps {
  canConfirm: boolean;
  canPick: boolean;
  canDecide: boolean;
  canUndo: boolean;
  /** Why drafting links is unavailable, shown in place of the consequence text. */
  readOnlyReason?: string;
  message: string;
  /** A decision was just made: the next entry, shown during the pause. */
  advancing?: { name: string; ms: number; token: number };
  onConfirm(): void;
  onPick(): void;
  onNone(): void;
  onSkip(): void;
  onUndo(): void;
}

const advanceLabel = (ms: number) => (ms === 0 ? 'Off' : `${ms / 1000} s`);

/** One bar of decisions: Confirm, Pick row, Not needed, Skip, Undo, and the advance pause. */
export function CompendiumActionBar({
  canConfirm,
  canPick,
  canDecide,
  canUndo,
  readOnlyReason,
  message,
  advancing,
  onConfirm,
  onPick,
  onNone,
  onSkip,
  onUndo,
}: ActionBarProps) {
  const ms = useAdvanceSetting((state) => state.ms);
  const setMs = useAdvanceSetting((state) => state.set);
  return (
    <footer className={styles.actionBar} aria-label="Review actions">
      {advancing && (
        <span
          key={advancing.token}
          className={styles.advanceLine}
          style={{ animationDuration: `${advancing.ms}ms` }}
          aria-hidden="true"
        />
      )}
      <button type="button" className={styles.primary} disabled={!canConfirm} onClick={onConfirm}>
        Confirm <kbd>⏎</kbd>
      </button>
      <button type="button" disabled={!canPick} onClick={onPick}>
        Pick row <kbd>P</kbd>
      </button>
      <button type="button" disabled={!canDecide} onClick={onNone}>
        Not needed <kbd>N</kbd>
      </button>
      <button type="button" disabled={!canDecide} onClick={onSkip}>
        Skip <kbd>S</kbd>
      </button>
      <button type="button" disabled={!canUndo} onClick={onUndo}>
        Undo <kbd>U</kbd>
      </button>
      <span className={styles.barRight}>
        {advancing ? (
          <span className={styles.next}>
            Next: <strong>{advancing.name}</strong> · Esc to stay
          </span>
        ) : (
          <span className={styles.consequence} role="status">
            {message || readOnlyReason || 'Confirm drafts a link, not a save · Skip and Not needed stay in this browser.'}
          </span>
        )}
        <label className={styles.advanceSetting}>
          <span>Auto-advance</span>
          <select
            aria-label="Auto-advance pause"
            value={ms}
            onChange={(event) => setMs(Number(event.target.value))}
          >
            {advanceChoices.map((choice) => (
              <option key={choice} value={choice}>
                {advanceLabel(choice)}
              </option>
            ))}
          </select>
        </label>
      </span>
    </footer>
  );
}
