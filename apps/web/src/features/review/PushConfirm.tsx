import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { rowKey } from './globalRows';
import { rowIdentity } from './globalsPending';
import { kindCounts, type Kind } from './kinds';
import { languageLabel } from '../../languageLabels';
import { isLane, type LaneEntry } from './lanes';
import type { PendingTooltip } from './model';
import { AffectedTooltips } from './TranslationDetail';
import type { RowKinds } from './queueModel';
import styles from './Review.module.scss';

const named = ({ name, lane }: LaneEntry) => `${name} in ${languageLabel(lane.lang)}`;

/** "2 German translations and 1 French translation". */
function languageCounts(entries: readonly LaneEntry[]): string {
  const counts = new Map<string, number>();
  for (const { lane } of entries) counts.set(lane.lang, (counts.get(lane.lang) ?? 0) + 1);
  return new Intl.ListFormat('en').format(
    [...counts].map(([lang, n]) => `${n} ${languageLabel(lang)} translation${n === 1 ? '' : 's'}`),
  );
}

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
  held,
  background = false,
  onConfirm,
  onCancel,
}: {
  entries: PendingTooltip[];
  /** Each row's word, for the by-kind line and the list. */
  kinds: RowKinds;
  /** New globals that publish along, with the row that uses each. */
  needed?: ReadonlyMap<PendingTooltip, string>;
  /** Ticked translations left out, each with the one it has to be reviewed after. */
  held?: ReadonlyMap<PendingTooltip, PendingTooltip>;
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
  const translations = entries.filter(isLane);
  const removals = translations.filter(({ lane }) => !lane.saved);
  // A removal asks once more, in place of the buttons.
  const [removing, setRemoving] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (removing) cancel.current?.focus();
  }, [removing]);
  const globals = entries.filter(({ part }) => part?.pending);
  const tooltips = translations.length ? [] : entries.filter(({ part }) => !part?.pending);
  const updated = new Set(globals.flatMap(({ part }) => part!.pending!.affected)).size;
  const label = background ? `Publish ${count}` : `Push ${count} live`;
  return (
    <Dialog
      title={background ? 'Publish to live' : 'Push to live'}
      onClose={onCancel}
      footer={
        <>
          {removing && (
            <p className={styles.confirmRemoval}>
              {removals.length === 1
                ? `Remove ${named(removals[0]!)}? Players see English again.`
                : `Remove ${removals.length} translations? Players see English again.`}
            </p>
          )}
          <button
            type="button"
            ref={confirm}
            className={removing ? styles.danger : styles.primary}
            onKeyDown={(event) => {
              // A held Enter that opened this dialog would otherwise confirm it by auto-repeat.
              if (event.repeat) event.preventDefault();
            }}
            onClick={(event) => {
              // detail > 1: the second click of a double-click that landed here.
              if (used.current || event.detail > 1) return;
              if (removals.length && !removing) return setRemoving(true);
              used.current = true;
              onConfirm();
            }}
          >
            {removing ? `Remove and publish ${count}` : label}
          </button>
          <button
            type="button"
            ref={cancel}
            onClick={removing ? () => setRemoving(false) : onCancel}
          >
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
      {translations.length > 0 && (
        <p className={styles.confirmSummary}>
          {languageCounts(translations)} {translations.length === 1 ? 'goes' : 'go'} live for
          everyone using Clarity. Nothing else does.
          {removals.length > 0 &&
            ` ${removals.length} ${removals.length === 1 ? 'is a removal' : 'are removals'}: players see English again.`}
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
        aria-label={
          translations.length
            ? 'Translations going live'
            : globals.length
              ? 'Changes going live'
              : 'Tooltips going live'
        }
        tabIndex={0}
      >
        {entries.map((entry) => (
          <li key={entry.tooltip.hash}>
            <span className={styles.confirmName}>{entry.name}</span>
            <small>
              {entry.category} · {rowIdentity(entry)}
              {entry.lane && ` · ${languageLabel(entry.lane.lang)}`}
              {needed?.has(entry) && `, used by ${needed.get(entry)}`}
            </small>
            <small className={styles.confirmKind}>{kindOf(entry) ?? ''}</small>
            {isLane(entry) && (
              <AffectedTooltips entry={entry} open className={styles.confirmUpdates} />
            )}
          </li>
        ))}
      </ul>
      {held && held.size > 0 && (
        <>
          <p className={styles.confirmSummary}>
            Not in this publish. Review {held.size === 1 ? 'it' : 'these'} again once the other is
            live:
          </p>
          <ul
            className={styles.confirmList}
            data-held=""
            aria-label="Not in this publish"
            tabIndex={0}
          >
            {[...held].map(([entry, other]) => (
              <li key={entry.tooltip.hash}>
                <span className={styles.confirmName}>{entry.name}</span>
                <small>
                  {entry.category} · {rowIdentity(entry)}
                  {entry.lane && ` · ${languageLabel(entry.lane.lang)}`}
                </small>
                <small className={styles.confirmKind}>After {other.name}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
