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
  const pause = (
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
  );
  const undo = (className?: string) => (
    <button type="button" className={className} disabled={!canUndo} onClick={onUndo}>
      Undo <kbd>U</kbd>
    </button>
  );
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
        Pick<span className={styles.rowWord}> row</span> <kbd>P</kbd>
      </button>
      <button type="button" disabled={!canDecide} onClick={onNone}>
        Not needed <kbd>N</kbd>
      </button>
      <button type="button" disabled={!canDecide} onClick={onSkip}>
        Skip <kbd>S</kbd>
      </button>
      {undo(styles.undoInline)}
      {/* A narrow bar (small window, phone, large interface scale) keeps the four decisions and
          folds the rest into one menu; the markup is shared, the container decides. */}
      <details className={styles.more}>
        <summary aria-label="More actions">⋯</summary>
        <div className={styles.moreMenu}>
          {undo()}
          {pause}
        </div>
      </details>
      {/* The decision announcement survives the phone bar, which hides the visible line. */}
      <span className="sr-only" role="status">
        {message}
      </span>
      <span className={styles.barRight}>
        {advancing ? (
          <span className={styles.next}>
            Next: <strong>{advancing.name}</strong> · Esc stays
          </span>
        ) : (
          <span className={styles.consequence} title={message || readOnlyReason}>
            {message || readOnlyReason || 'Confirm drafts a link, not a save.'}
          </span>
        )}
        {pause}
      </span>
    </footer>
  );
}
