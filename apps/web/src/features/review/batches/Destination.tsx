import { useEffect, useMemo } from 'react';
import { nonTranslationChanges } from '@clarity/core/schedule';
import type { Change } from '../../../services/api';
import { zonedNotBefore } from '../../../services/format/date';
import { memberCap } from '../../../services/scheduled/api';
import { draftsOfBatch, useBatchDraftStore } from '../../../services/scheduled/batchDrafts';
import { fieldList, orderBatches, statusLabel } from './model';
import { nameFor } from './names';
import { startBatches, useBatches } from './store';
import { useDataStore } from '../../../stores/data';
import type { Destination } from './saveDestination';
import styles from './Batches.module.scss';

export type { Destination };
export { saveReviewToBatch } from './saveDestination';

/**
 * Review save's Destination row (maintainers and editors): Current (today's save), an open batch,
 * or a new one. Only draft and scheduled batches take saves; a scheduled one takes translation
 * edits only, and a tooltip in another open batch is refused (Q2). The Worker decides; the row
 * only says so beforehand.
 */
export function DestinationRow({
  value,
  changes,
  disabled,
  onChange,
  onBlocked,
}: {
  value: Destination;
  /** The changes under review. */
  changes: readonly Change[];
  disabled: boolean;
  onChange(value: Destination): void;
  /** Why Save to batch is off (a refusal the Worker would give), or null. */
  onBlocked(reason: string | null): void;
}) {
  const hashes = useMemo(() => changes.map(({ hash }) => hash), [changes]);
  useEffect(startBatches, []);
  const entries = useBatches((state) => state.entries);
  const listError = useBatches((state) => state.listError);
  const data = useDataStore((state) => state.data);
  const open = useMemo(
    () =>
      orderBatches(entries ?? []).filter(
        (entry) => entry.status === 'draft' || entry.status === 'scheduled',
      ),
    [entries],
  );
  const chosen = value.kind === 'batch' ? open.find((entry) => entry.id === value.id) : undefined;
  // Drafts already staged for that batch (batch:<id>:<hash>) go in the same save.
  const staged = useBatchDraftStore((state) =>
    value.kind === 'batch' ? draftsOfBatch(state.drafts, value.id).size : 0,
  );
  // Q2: tooltips under review that another open batch already holds.
  const elsewhere = useMemo(() => {
    if (value.kind === 'current') return [];
    const wanted = new Set(hashes);
    return (entries ?? [])
      .filter(
        (entry) =>
          (entry.status === 'draft' ||
            entry.status === 'scheduled' ||
            entry.status === 'publishing') &&
          entry.id !== (value.kind === 'batch' ? value.id : ''),
      )
      .flatMap((entry) =>
        entry.hashes
          .filter((hash) => wanted.has(hash))
          .map((hash) => ({ hash, batch: entry.name })),
      );
  }, [entries, hashes, value]);
  const total = value.kind === 'current' ? 0 : new Set([...(chosen?.hashes ?? []), ...hashes]).size;
  // A scheduled batch takes translation edits of its own tooltips only (I5): anything else is the
  // Worker's 409 "Unschedule to edit", so name it now and keep Save to batch off.
  const refused = useMemo(() => {
    if (chosen?.status !== 'scheduled') return [];
    const held = new Set(chosen.hashes);
    return changes.flatMap((change) => {
      const label = `${nameFor(data, change.hash)} (${change.hash})`;
      if (!held.has(change.hash)) return [`${label}: not in the batch`];
      const fields = nonTranslationChanges(change.base, change.next);
      return fields.length ? [`${label}: ${fieldList(fields)}`] : [];
    });
  }, [chosen, changes, data]);
  const blockedBy = refused.length ? 'scheduled' : total > memberCap ? 'cap' : null;
  useEffect(() => onBlocked(blockedBy), [blockedBy, onBlocked]);
  useEffect(() => () => onBlocked(null), [onBlocked]);
  const pick = (kind: Destination['kind']) => {
    if (kind === 'current') onChange({ kind });
    else if (kind === 'new') onChange({ kind, name: value.kind === 'new' ? value.name : '' });
    else if (open[0]) onChange({ kind, id: chosen?.id ?? open[0].id });
  };
  return (
    <fieldset className={styles.destination} data-destination={value.kind} disabled={disabled}>
      <legend>Destination</legend>
      <span className={styles.destinationModes} role="group" aria-label="Save destination">
        <button
          type="button"
          aria-pressed={value.kind === 'current'}
          onClick={() => pick('current')}
        >
          Current
        </button>
        <button
          type="button"
          aria-pressed={value.kind === 'batch'}
          disabled={!open.length}
          title={open.length ? undefined : 'No open batch takes saves'}
          onClick={() => pick('batch')}
        >
          Batch
        </button>
        <button type="button" aria-pressed={value.kind === 'new'} onClick={() => pick('new')}>
          New batch…
        </button>
      </span>
      {value.kind === 'batch' && (
        <select
          aria-label="Batch"
          value={value.id}
          onChange={(event) => onChange({ kind: 'batch', id: event.target.value })}
        >
          {open.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {statusLabel[entry.status]}
              {entry.notBefore ? ` · ${zonedNotBefore(entry.notBefore)}` : ''}
            </option>
          ))}
        </select>
      )}
      {value.kind === 'new' && (
        <input
          aria-label="New batch name"
          placeholder="Batch name"
          maxLength={80}
          value={value.name}
          onChange={(event) => onChange({ kind: 'new', name: event.target.value })}
        />
      )}
      {value.kind !== 'current' && (
        <p className={styles.destinationNote} data-destination-note>
          {value.kind === 'new'
            ? 'Creates a draft batch and saves these changes into it. Nothing publishes until it is scheduled.'
            : chosen
              ? chosen.notBefore
                ? `Not published before ${zonedNotBefore(chosen.notBefore)}.${chosen.status === 'scheduled' && !refused.length ? ' A scheduled batch takes translation edits only.' : ''}`
                : 'Draft batch: no time set yet.'
              : ''}{' '}
          Current saved text stays as it is; the drafts move into the batch.
          {staged > 0 &&
            ` Also saves ${staged} ${staged === 1 ? 'draft' : 'drafts'} already staged for this batch.`}
        </p>
      )}
      {elsewhere.length > 0 && (
        <p className={styles.destinationNote} role="note">
          Already in another open batch (one batch per tooltip):{' '}
          {elsewhere.map(({ hash, batch }) => `${nameFor(data, hash)} (${batch})`).join(', ')}.
        </p>
      )}
      {refused.length > 0 && (
        <p className={styles.destinationNote} role="alert" data-scheduled-refusal>
          A scheduled batch takes translation edits of its own tooltips only. Unschedule it first
          (Review → Batches), or save these to Current: {refused.join('; ')}.
        </p>
      )}
      {total > memberCap && (
        <p className={styles.destinationNote} role="alert" data-over-cap>
          A batch holds at most {memberCap} tooltips; this save would make {total}. Save fewer
          drafts, or save to Current.
        </p>
      )}
      {listError && value.kind !== 'current' && (
        <p className={styles.destinationNote} role="alert">
          {listError}
        </p>
      )}
    </fieldset>
  );
}
