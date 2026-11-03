import { useEffect, useState } from 'react';
import { isTerminal } from '../../services/publisher/opStore';
import { publishDriver } from './publisher';
import { usePublishState } from './publishDriver';
import { describeOp, foreignWaiting, groupPublishes } from './publishStatus';
import { exactDate, formatDate } from '../../services/format/date';
import { useSyncedSettings } from '../../stores/settings';
import type { Bundle } from '../../services/bundle';
import styles from './Review.module.scss';

/** Re-renders every 15 s while something runs, so "Publishing" can become "Waiting" without any request. */
function useNow(running: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 15_000);
    return () => clearInterval(timer);
  }, [running]);
  return Date.now();
}

/**
 * One dense line per publish this account started (newest last), plus one line for requests other
 * editors have queued that nobody has picked up. Rendered only for editors/maintainers with the
 * publisher flag on. Lines keep a fixed grid (chip | text | action) so a status change never
 * moves anything: long reasons clamp and carry the full text in the tooltip.
 */
export function PublishActivity({ queue }: { queue: Bundle['publishQueue'] }) {
  const { ops, notes, storageError } = usePublishState();
  const running = ops.some((op) => !isTerminal(op.status)) || Boolean(queue?.length);
  const now = useNow(running);
  const settings = useSyncedSettings();
  // Lines read "2 minutes ago" (short, and it ages without a request); tooltips carry the exact time.
  const when = (ms: number) => formatDate(ms, { ...settings, timeDisplay: 'relative' }, { now });
  const exact = (ms: number) => exactDate(ms, { ...settings, timeDisplay: 'datetime' });
  const own = new Set(ops.map((op) => op.opId));
  const others = foreignWaiting(queue, own, now);
  if (!ops.length && !others && !storageError) return null;
  return (
    <section className={styles.activity} aria-label="Publish activity">
      {storageError && <p role="alert">{storageError}</p>}
      <ul>
        {groupPublishes(ops).map(({ op, members }) => {
          const note = members.map((member) => notes[member.opId]).find(Boolean);
          const view = describeOp(op, note, now, when);
          if (members.length > 1 && !view.finished) {
            const done = members
              .filter((member) => member.status === 'done' || member.status === 'unchanged')
              .reduce((count, member) => count + member.hashes.length, 0);
            view.detail = `${done} of ${op.hashes.length} tooltips confirmed live. ${view.detail}`;
          }
          return (
            <li key={op.opId} data-tone={view.tone} data-status={op.status}>
              <span className={styles.activityChip}>{view.chip}</span>
              <span
                className={styles.activityText}
                title={`${view.lead} (${exact(op.createdAt)}) — ${view.detail}`}
              >
                <b>{view.lead}</b> {view.detail}
              </span>
              <span className={styles.activityAction}>
                {view.waiting && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const member of members) void publishDriver.kickWaiting(member.opId);
                    }}
                  >
                    Retry
                  </button>
                )}
                {view.finished && (
                  <button
                    type="button"
                    aria-label={`Dismiss publish from ${exact(op.createdAt)}`}
                    onClick={() => {
                      for (const member of members) void publishDriver.dismiss(member.opId);
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {others && (
          <li data-tone="warn" data-status="foreign">
            <span className={styles.activityChip}>Waiting</span>
            <span
              className={styles.activityText}
              title={`${others.count} publish request${others.count === 1 ? '' : 's'} from other editors waiting since ${exact(others.since)}`}
            >
              <b>
                {others.count} publish request{others.count === 1 ? '' : 's'} waiting
              </b>{' '}
              · queued {when(others.since)}.
            </span>
            <span className={styles.activityAction}>
              <button type="button" onClick={() => void publishDriver.kickRemote(others.opId)}>
                Retry
              </button>
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
