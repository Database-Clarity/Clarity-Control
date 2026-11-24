import { useEffect, useRef } from 'react';
import { Dialog } from '../../ui/Dialog';
import { rowKey } from './globalRows';
import { rowIdentity } from './globalsPending';
import { kindCounts, type Kind } from './kinds';
import type { PendingTooltip } from './model';
import type { RowKinds } from './queueModel';
import styles from './Review.module.scss';

/**
 * Last look before anything goes live: how many, of which kinds, and exactly which. Enter confirms
 * (the button has focus), Esc or Cancel backs out. Confirming works once: a repeated Enter (key
 * held down), the second click of a double-click, or a second activation before the dialog has
 * unmounted is ignored, so one confirmation never becomes two pushes.
 */
export function PushConfirm({
  entries,
  kinds,
  needed,
  background = false,
  onConfirm,
  onCancel,
}: {
  entries: PendingTooltip[];
  /** Each row's word, for the by-kind line and the list. */
  kinds: RowKinds;
  /** New globals that publish along, with the row that uses each. */
  needed?: ReadonlyMap<PendingTooltip, string>;
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
  const kindOf = (entry: PendingTooltip): Kind | undefined => kinds.get(rowKey(entry));
  const globals = entries.filter(({ part }) => part?.pending);
  const tooltips = entries.filter(({ part }) => !part?.pending);
  const updated = new Set(globals.flatMap(({ part }) => part!.pending!.affected)).size;
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
            className={styles.primary}
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
      {tooltips.length > 0 && (
        <p className={styles.confirmSummary}>
          {/* "19 new tooltips and 6 with no visible change go live …" */}
          {kindCounts(tooltips.map(kindOf))} {tooltips.length === 1 ? 'goes' : 'go'} live for
          everyone using Clarity.
        </p>
      )}
      {globals.length > 0 && (
        <p className={styles.confirmSummary}>
          {globals.length === 1 ? '1 global goes' : `${globals.length} globals go`} live
          {updated > 0 &&
            ` and ${globals.length === 1 ? 'updates' : 'update'} ${updated} published ${updated === 1 ? 'tooltip' : 'tooltips'}`}
          .
        </p>
      )}
      {background && (
        <p className={styles.confirmSummary}>
          Publishing runs in the background. Check the Review page to see what went live.
        </p>
      )}
      <ul
        className={styles.confirmList}
        aria-label={globals.length ? 'Changes going live' : 'Tooltips going live'}
        tabIndex={0}
      >
        {entries.map((entry) => (
          <li key={entry.tooltip.hash}>
            <span className={styles.confirmName}>{entry.name}</span>
            <small>
              {entry.category} · {rowIdentity(entry)}
              {needed?.has(entry) && `, used by ${needed.get(entry)}`}
            </small>
            <small className={styles.confirmKind}>{kindOf(entry) ?? ''}</small>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
