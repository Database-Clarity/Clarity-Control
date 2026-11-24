import { useEffect, useRef } from 'react';
import { Dialog } from '../../ui/Dialog';
import { rowKey, unitName } from './globalRows';
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
  rows,
  kinds,
  background = false,
  onConfirm,
  onCancel,
}: {
  entries: PendingTooltip[];
  /** The list's rows of these changes (a globals file has one per changed entry). */
  rows: PendingTooltip[];
  /** Each row's word, for the by-kind line and the list. */
  kinds: RowKinds;
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
  const byFile = new Map<number, PendingTooltip[]>();
  for (const row of rows) {
    const file = byFile.get(row.tooltip.hash);
    if (file) file.push(row);
    else byFile.set(row.tooltip.hash, [row]);
  }
  const rowsOf = (entry: PendingTooltip) => byFile.get(entry.tooltip.hash) ?? [entry];
  // A globals file is one change, so its word must hold for every one of its rows.
  const kindOf = (entry: PendingTooltip): Kind | undefined => {
    const own = rowsOf(entry);
    const words = new Set(own.map((row) => kinds.get(rowKey(row))));
    const [word] = words;
    if (words.has(undefined)) return undefined;
    if (!own[0]!.part) return word;
    if (words.has('Text changed')) return 'Text changed';
    // Single entries being new or removed do not make the file so.
    if (words.size === 1 && (entry.isNew || (word !== 'New' && word !== 'Removed'))) return word;
    return 'Definition changed';
  };
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
      <p className={styles.confirmSummary}>
        {/* "19 new tooltips and 6 with no visible change go live …" */}
        {kindCounts(entries.map(kindOf))} {count === 1 ? 'goes' : 'go'} live for everyone using
        Clarity.
      </p>
      {background && (
        <p className={styles.confirmSummary}>
          Publishing runs in the background. Check the Review page to see what went live.
        </p>
      )}
      <ul className={styles.confirmList} aria-label="Tooltips going live" tabIndex={0}>
        {entries.map((entry) => (
          <li key={entry.tooltip.hash}>
            <span className={styles.confirmName}>{unitName(rowsOf(entry)[0]!)}</span>
            <small>
              {entry.category} · {entry.tooltip.hash}
            </small>
            <small className={styles.confirmKind}>{kindOf(entry) ?? ''}</small>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
