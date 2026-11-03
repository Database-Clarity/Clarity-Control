import { useEffect, useRef } from 'react';
import { Dialog } from '../../ui/Dialog';
import type { PendingTooltip } from './model';
import styles from './Review.module.scss';

/**
 * Last look before anything goes live: how many, and exactly which. Enter confirms (the button
 * has focus), Esc or Cancel backs out. Confirming works once: a repeated Enter (key held down),
 * the second click of a double-click, or a second activation before the dialog has unmounted
 * is ignored, so one confirmation never becomes two pushes.
 */
export function PushConfirm({
  entries,
  background = false,
  onConfirm,
  onCancel,
}: {
  entries: PendingTooltip[];
  /** Publisher flow: the run happens in the background after confirming (wording only). */
  background?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const used = useRef(false);
  const confirm = useRef<HTMLButtonElement>(null);
  // Dialog's effect (a child) opens it first; only then can focus land on the button, and
  // showModal would otherwise leave it on the header's Close button.
  useEffect(() => confirm.current?.focus(), []);
  const count = entries.length;
  const label = background ? `Publish ${count}` : `Push ${count} live`;
  return (
    <Dialog
      title={background ? 'Publish to live' : 'Push to live'}
      onClose={onCancel}
      footer={
        <>
          <button
            type="button"
            ref={confirm}
            onKeyDown={(event) => {
              // A held Enter that opened this dialog would otherwise confirm it by auto-repeat.
              if (event.repeat) event.preventDefault();
            }}
            onClick={(event) => {
              // detail > 1: the second click of a double-click that landed here.
              if (used.current || event.detail > 1) return;
              used.current = true;
              onConfirm();
            }}
          >
            {label}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p className={styles.confirmSummary}>
        {count === 1 ? '1 tooltip goes' : `${count} tooltips go`} live for everyone using Clarity.
      </p>
      {background && (
        <p className={styles.confirmSummary}>
          Publishing runs in the background and takes a minute or two. You can keep working;
          progress shows on the Review page.
        </p>
      )}
      <ul className={styles.confirmList} aria-label="Tooltips going live" tabIndex={0}>
        {entries.map(({ tooltip, name, category }) => (
          <li key={tooltip.hash}>
            <span className={styles.confirmName}>{name}</span>
            <small>
              {category} · {tooltip.hash}
            </small>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
