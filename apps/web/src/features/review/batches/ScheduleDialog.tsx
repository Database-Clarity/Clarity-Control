import { useMemo, useState } from 'react';
import type { Batch } from '@clarity/core/schedule';
import { Dialog } from '../../../ui/Dialog';
import { browserTimeZone, zonedNotBefore } from '../../../services/format/date';
import { scheduleBatch } from '../../../services/scheduled/api';
import {
  chosenNotBefore,
  defaultTime,
  interpret,
  offsetLabel,
  utcLabel,
  zoneOptions,
} from './scheduleTime';
import { Refusal } from './Refusal';
import styles from './Batches.module.scss';

/**
 * Schedule… / Reschedule…: a date and a minute in the device zone (or a picked one), shown with
 * its UTC time and offset. A time the zone skips is refused; a repeated one asks which offset.
 * Sends the batch revision it was opened on (CAS): a batch that changed meanwhile is refused by
 * the Worker, verbatim, and the dialog stays open with the new state behind it.
 */
export function ScheduleDialog({
  batch,
  firstPublications,
  names,
  onClose,
  onDone,
}: {
  batch: Batch;
  /** Members that were never published (C4): they publish whole. */
  firstPublications: number[];
  names: (hash: number) => string;
  onClose(): void;
  onDone(message: string): void;
}) {
  const device = browserTimeZone();
  const zones = useMemo(() => zoneOptions(device), [device]);
  const [zone, setZone] = useState(() =>
    batch.zone && zones.includes(batch.zone) ? batch.zone : zones.includes(device) ? device : 'UTC',
  );
  const start = useMemo(() => defaultTime(zone, batch.notBefore), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [offset, setOffset] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choice = interpret(date, time, zone, offset);
  const chosen = chosenNotBefore(choice);
  const reschedule = batch.status === 'scheduled';
  const verb = reschedule ? 'Reschedule' : 'Schedule';

  async function submit() {
    if ('error' in chosen || pending) return;
    setPending(true);
    setError(null);
    try {
      const { batch: next } = await scheduleBatch(batch.id, batch.revision, chosen.notBefore, zone);
      onDone(
        `${batch.name} ${reschedule ? 'rescheduled' : 'scheduled'}: not published before ${zonedNotBefore(next.notBefore ?? chosen.notBefore)}.`,
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title={`${verb} ${batch.name}`}
      busy={pending}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className={styles.primary}
            disabled={pending || 'error' in chosen}
            onClick={() => void submit()}
          >
            {pending ? `${verb.replace(/e$/, '')}ing...` : verb}
          </button>
          <button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className={styles.when}>
        <label>
          Date
          <input
            type="date"
            value={date}
            disabled={pending}
            onChange={(event) => {
              setDate(event.target.value);
              setOffset(null);
            }}
          />
        </label>
        <label>
          Time
          <input
            type="time"
            step={60}
            value={time}
            disabled={pending}
            onChange={(event) => {
              setTime(event.target.value.slice(0, 5));
              setOffset(null);
            }}
          />
        </label>
        <label className={styles.zone}>
          Time zone
          <select
            value={zone}
            disabled={pending}
            onChange={(event) => {
              setZone(event.target.value);
              setOffset(null);
            }}
          >
            {zones.map((value) => (
              <option key={value} value={value}>
                {value === device ? `${value} (this device)` : value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {choice.kind === 'exact' && (
        <p className={styles.utcLine} data-utc>
          {utcLabel(choice.notBefore, date)} · {offsetLabel(choice.offsetMinutes)}
        </p>
      )}
      {choice.kind === 'overlap' && (
        <fieldset className={styles.overlap}>
          <legend>
            {time} happens twice on this day in {zone}. Which one?
          </legend>
          {choice.options.map((option, index) => (
            <label key={option.notBefore}>
              <input
                type="radio"
                name="offset"
                checked={offset === option.offsetMinutes}
                disabled={pending}
                onChange={() => setOffset(option.offsetMinutes)}
              />
              {index === 0 ? 'First' : 'Second'} {time} ({offsetLabel(option.offsetMinutes)}) ·{' '}
              {utcLabel(option.notBefore, date)}
            </label>
          ))}
        </fieldset>
      )}
      {'error' in chosen && choice.kind !== 'overlap' && (
        <p role="alert" data-time-error>
          {chosen.error}
        </p>
      )}
      {firstPublications.length > 0 && (
        <section aria-label="First publications" className={styles.firstList}>
          <p>
            First publication:{' '}
            {firstPublications.length === 1 ? 'this tooltip publishes' : 'these tooltips publish'}{' '}
            whole (never published before).
          </p>
          <ul>
            {firstPublications.map((hash) => (
              <li key={hash}>
                {names(hash)} <span className={styles.muted}>{hash}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error !== null && <Refusal error={error} names={names} />}
    </Dialog>
  );
}
