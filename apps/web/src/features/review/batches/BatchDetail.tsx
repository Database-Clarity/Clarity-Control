import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { contentHash, mergeTextWithMarkers, type Tooltip } from '@clarity/core';
import {
  existsField,
  fieldValue,
  resolveActivation,
  type ActivationChoice,
  type ActivationConflict,
  type Batch,
} from '@clarity/core/schedule';
import { useAuthStore } from '../../../stores/auth';
import { useDataStore } from '../../../stores/data';
import { zonedNotBefore } from '../../../services/format/date';
import {
  endBatchSchedule,
  kickBatch,
  readArchivedEvents,
  rebaseMember,
  removeFromBatch,
  resolveActivationConflict,
  scheduleBatch,
  type BatchEvent,
} from '../../../services/scheduled/api';
import { canPushLive } from '../../auth/permissions';
import { itemFor } from '../../navigation/catalog';
import { TooltipDiff } from '../../history/TooltipDiff';
import {
  actor,
  eventLabel,
  fieldLabel,
  fieldList,
  isOverdue,
  memberView,
  outcomeLines,
  resultLabel,
  statusLabel,
  statusTone,
  translationCoverage,
  type IndexEntry,
  type MemberView,
} from './model';
import { refreshBatches, retryBatch, useBatches } from './store';
import { ScheduleDialog } from './ScheduleDialog';
import { Refusal } from './Refusal';
import { useNames } from './names';
import styles from './Batches.module.scss';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (value: unknown) => {
  const text = value === undefined || value === null ? 'none' : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};
const at = (iso: string) => zonedNotBefore(iso);
/** The 2-minute pre-due window: advisory only (the claim fence is the guard). */
const soonMs = 2 * 60_000;

type Action = 'schedule' | 'now' | 'unschedule' | 'cancel' | 'kick';

/**
 * One batch: status and revisions, the not-before line, the task strip, the change list (diff vs
 * current saved, first publications, stale fields as conflict blocks with Rebase), activation
 * conflicts (Apply upcoming / Keep current), the result, and the audit events.
 */
export function BatchDetail({ entry }: { entry: IndexEntry }) {
  const load = useBatches((state) => state.loads[entry.id]);
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const names = useNames();
  const detail = load && 'detail' in load ? load.detail : undefined;
  // Writes wait until the detail is read at the listed revision: never act on an older batch.
  const fresh = load?.state === 'ready' && load.revision === entry.revision;
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [dialog, setDialog] = useState(false);
  const views = useMemo(
    () =>
      detail && data
        ? detail.members.map((member) =>
            memberView(
              member,
              data.bundle.tooltips[member.hash] ?? null,
              member.hash in data.bundle.pushed,
            ),
          )
        : [],
    [detail, data],
  );
  if (!detail)
    return load?.state === 'failed' ? (
      <p role="alert" className={styles.note}>
        {load.error}{' '}
        <button type="button" className={styles.textButton} onClick={() => retryBatch(entry.id)}>
          Retry
        </button>
      </p>
    ) : (
      <p className={styles.note}>Loading {entry.name}…</p>
    );
  const batch = detail.batch;
  const manage = canPushLive(user);
  const stale = views.filter((view) => view.stale.length);
  const first = views.filter((view) => view.first).map((view) => view.member.hash);
  const overdue = isOverdue(batch);
  const coverage = translationCoverage(detail.members);

  async function run(label: string, write: () => Promise<unknown>, done: string) {
    if (pending) return;
    setPending(label);
    setError(null);
    setNotice(null);
    setConfirm(null);
    try {
      await write();
      setNotice(done);
    } catch (reason) {
      setError(reason);
    } finally {
      // Refusals too: "The batch changed" means the detail should show the batch as it is now.
      await refreshBatches();
      setPending(null);
    }
  }

  const blocked = !fresh || Boolean(pending);
  const scheduleBlock = !detail.members.length
    ? 'Add a tooltip to the batch first.'
    : stale.length
      ? `Rebase ${plural(stale.length, 'stale tooltip')} first.`
      : null;
  const scheduler = [...batch.events]
    .reverse()
    .find((event) => event.action === 'schedule' || event.action === 'reschedule');

  return (
    <section aria-label={`Batch ${batch.name}`} data-batch={batch.id} data-status={batch.status}>
      <div className={styles.identity}>
        <h2 title={batch.name}>{batch.name}</h2>
        <span className={styles.chip} data-tone={overdue ? 'warn' : statusTone[batch.status]}>
          {overdue ? 'Overdue' : statusLabel[batch.status]}
        </span>
        <span className={styles.identityEnd}>
          <span className={styles.muted}>
            rev {batch.revision} · content {batch.contentRevision}
          </span>
        </span>
      </div>
      <StatusLines batch={batch} overdue={overdue} names={names} />
      <p className={styles.line}>
        Created by {actor(batch.createdBy.login)} {at(batch.createdAt)}
        {scheduler && (
          <>
            {' '}
            · {scheduler.action === 'reschedule' ? 'rescheduled' : 'scheduled'} by{' '}
            {actor(scheduler.by.login)}
          </>
        )}
        {coverage.needed > 0 && (
          <>
            {' '}
            · upcoming translations {coverage.ready}/{coverage.needed} ready
          </>
        )}
      </p>
      {manage && (
        <TaskStrip
          batch={batch}
          overdue={overdue}
          blocked={blocked}
          scheduleBlock={scheduleBlock}
          pending={pending}
          confirm={confirm}
          members={detail.members.length}
          onConfirm={setConfirm}
          onSchedule={() => {
            setError(null);
            setNotice(null);
            setDialog(true);
          }}
          onNow={() =>
            void run(
              'now',
              () => scheduleBatch(batch.id, batch.revision, 'now', batch.zone ?? 'UTC'),
              `${batch.name} is queued to publish now.`,
            )
          }
          onEnd={(action) =>
            void run(
              action,
              () => endBatchSchedule(batch.id, batch.revision, action),
              action === 'cancel'
                ? `${batch.name} cancelled. Nothing from it will publish.`
                : `${batch.name} unscheduled: back to draft.`,
            )
          }
          onKick={() =>
            void run('kick', () => kickBatch(batch.id), 'Kicked: the publisher was asked to run.')
          }
        />
      )}
      {!fresh && load?.state === 'loading' && (
        <p className={styles.note} role="status">
          The batch changed; reading revision {entry.revision}…
        </p>
      )}
      {load?.state === 'failed' && (
        <p role="alert" className={styles.note}>
          {load.error}{' '}
          <button type="button" className={styles.textButton} onClick={() => retryBatch(entry.id)}>
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {error !== null && <Refusal error={error} names={names} />}
      {detail.conflicts.length > 0 && (
        <section aria-label="Activation conflicts" className={styles.section}>
          <h3>Activation conflicts ({detail.conflicts.length})</h3>
          <p className={styles.line}>
            The batch published, but current changed these fields meanwhile, so current was kept.
            Publishing these tooltips waits until each is resolved.
          </p>
          {detail.conflicts.map((conflict) => (
            <ConflictResolver
              key={conflict.hash}
              batch={batch}
              conflict={conflict}
              manage={manage}
              blocked={blocked}
              names={names}
            />
          ))}
        </section>
      )}
      <section aria-label="Changes" className={styles.section}>
        <h3>
          Changes ({detail.members.length})
          {stale.length > 0 && <span className={styles.staleCount}> · {stale.length} stale</span>}
        </h3>
        {!views.length && <p className={styles.note}>No tooltips in this batch yet.</p>}
        <ul className={styles.members}>
          {views.map((view) => (
            <MemberRow
              key={view.member.hash}
              view={view}
              batch={batch}
              manage={manage}
              blocked={blocked}
              name={names(view.member.hash)}
            />
          ))}
        </ul>
      </section>
      <Events batch={batch} head={detail.head} />
      {dialog && (
        <ScheduleDialog
          batch={batch}
          firstPublications={first}
          names={names}
          onClose={() => {
            setDialog(false);
            void refreshBatches();
          }}
          onDone={(message) => {
            setDialog(false);
            setNotice(message);
            void refreshBatches();
          }}
        />
      )}
    </section>
  );
}

/** Spec "Editor UX" Status: Scheduled → Publishing → Published | Draft with the last failure. */
function StatusLines({
  batch,
  overdue,
  names,
}: {
  batch: Batch;
  overdue: boolean;
  names: (hash: number) => string;
}) {
  const result = batch.result;
  const due = batch.notBefore ? Date.parse(batch.notBefore) : null;
  const soon =
    batch.status === 'scheduled' && due !== null && due - Date.now() <= soonMs && !overdue;
  return (
    <>
      <p className={styles.line} data-not-before>
        {batch.notBefore
          ? `Not published before ${at(batch.notBefore)}${batch.zone ? ` (chosen in ${batch.zone})` : ''}`
          : 'No time set'}
        {soon && ' · about to publish'}
      </p>
      {batch.status === 'publishing' && batch.claim && (
        <p className={styles.line} data-status-line>
          Publishing: started {at(batch.claim.claimedAt)}
          {overdue && '; still running past its time. Kick asks the publisher to run again.'}
        </p>
      )}
      {batch.status === 'scheduled' && overdue && (
        <p className={styles.warnLine} data-status-line>
          Overdue: the publisher has not started yet. It publishes as soon as it runs; Kick asks it
          to run now.
        </p>
      )}
      {batch.status === 'published' && result && (
        <p className={styles.line} data-status-line>
          {resultLabel(result.status)}{' '}
          {result.landedAt && (
            <>
              {at(result.landedAt)} (
              {result.landedAtSource === 'cas'
                ? 'publisher clock at the live write'
                : 'first observed after an interrupted run'}
              )
            </>
          )}
          {result.recordedAt && <> · recorded {at(result.recordedAt)}</>}
          {result.liveCommit && <> · live {result.liveCommit.slice(0, 8)}</>}
        </p>
      )}
      {batch.status === 'draft' && result && (
        <div className={styles.failed} data-status-line>
          <p>
            Last run failed: {resultLabel(result.status)}
            {result.error ? `: ${result.error}` : ''}
          </p>
          {outcomeLines(result).length > 0 && (
            <ul>
              {outcomeLines(result).map((line) => {
                const hash = Number(line.split(' ', 1)[0]);
                return <li key={line}>{`${names(hash)} ${line}`}</li>;
              })}
            </ul>
          )}
          {result.status === 'stale' && (
            <p>Rebase the stale tooltips below, then schedule again.</p>
          )}
        </div>
      )}
    </>
  );
}

function TaskStrip({
  batch,
  overdue,
  blocked,
  scheduleBlock,
  pending,
  confirm,
  members,
  onConfirm,
  onSchedule,
  onNow,
  onEnd,
  onKick,
}: {
  batch: Batch;
  overdue: boolean;
  blocked: boolean;
  scheduleBlock: string | null;
  pending: string | null;
  confirm: Action | null;
  members: number;
  onConfirm(action: Action | null): void;
  onSchedule(): void;
  onNow(): void;
  onEnd(action: 'unschedule' | 'cancel'): void;
  onKick(): void;
}) {
  const editable = batch.status === 'draft' || batch.status === 'scheduled';
  if (!editable && !overdue) return null;
  const busy = (label: string, text: string) => (pending === label ? `${text}...` : text);
  // In-place confirmations replace the strip's other actions, next to their trigger.
  if (confirm === 'cancel')
    return (
      <div className={styles.strip} role="group" aria-label="Confirm cancel">
        <span className={styles.confirmText}>
          Cancel {batch.name}? It stops for good: nothing in it publishes, and it cannot be
          reopened.
        </span>
        <button
          type="button"
          className={styles.danger}
          disabled={blocked}
          onClick={() => onEnd('cancel')}
        >
          {busy('cancel', 'Cancel batch')}
        </button>
        <button type="button" onClick={() => onConfirm(null)}>
          Keep batch
        </button>
      </div>
    );
  if (confirm === 'now')
    return (
      <div className={styles.strip} role="group" aria-label="Confirm publish now">
        <span className={styles.confirmText}>
          Publish {plural(members, 'tooltip')} live now, through the publisher?
        </span>
        <button type="button" className={styles.primary} disabled={blocked} onClick={onNow}>
          {busy('now', 'Publish now')}
        </button>
        <button type="button" onClick={() => onConfirm(null)}>
          Back
        </button>
      </div>
    );
  return (
    <div className={styles.strip} role="group" aria-label="Batch actions">
      {editable && (
        <>
          <button
            type="button"
            className={styles.primary}
            disabled={blocked || Boolean(scheduleBlock)}
            title={scheduleBlock ?? undefined}
            onClick={onSchedule}
          >
            {batch.status === 'scheduled' ? 'Reschedule…' : 'Schedule…'}
          </button>
          <button
            type="button"
            disabled={blocked || Boolean(scheduleBlock)}
            title={scheduleBlock ?? undefined}
            onClick={() => onConfirm('now')}
          >
            {busy('now', 'Publish now')}
          </button>
          {batch.status === 'scheduled' && (
            <button type="button" disabled={blocked} onClick={() => onEnd('unschedule')}>
              {busy('unschedule', 'Unschedule')}
            </button>
          )}
        </>
      )}
      {overdue && (
        <button type="button" disabled={blocked} onClick={onKick}>
          {busy('kick', 'Kick')}
        </button>
      )}
      {editable && (
        <button
          type="button"
          className={styles.dangerQuiet}
          disabled={blocked}
          onClick={() => onConfirm('cancel')}
        >
          Cancel batch…
        </button>
      )}
      {scheduleBlock && editable && <span className={styles.stripNote}>{scheduleBlock}</span>}
    </div>
  );
}

/** Fields a rebase or resolution must decide, against `current` now (core decides). */
function decisionFields(base: Tooltip | null, current: Tooltip | null, proposed: Tooltip) {
  try {
    const result = resolveActivation({ base, current, proposed, choices: {} });
    return result.ok ? [] : result.missing;
  } catch {
    return [];
  }
}

/** A text field both sides changed, as the editor's conflict block: mine = batch, theirs = current. */
function TextBlock({ base, mine, theirs }: { base: string; mine: string; theirs: string }) {
  const merged = mergeTextWithMarkers(base, mine, theirs).text;
  let part: 'both' | 'mine' | 'theirs' = 'both';
  return (
    <pre className={styles.block}>
      {merged.split(/\r?\n/).map((line, index) => {
        if (/^<{7}/.test(line)) {
          part = 'mine';
          return (
            <span key={index} className={styles.blockMarker}>
              Batch (mine)
            </span>
          );
        }
        if (/^={7}\s*$/.test(line) && part === 'mine') {
          part = 'theirs';
          return <span key={index} className={styles.blockRule} aria-hidden="true" />;
        }
        if (/^>{7}/.test(line) && part === 'theirs') {
          part = 'both';
          return (
            <span key={index} className={styles.blockMarker}>
              Current (theirs)
            </span>
          );
        }
        return (
          <span key={index} className={part === 'both' ? undefined : styles[part]}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

function FieldValues({
  field,
  base,
  mine,
  theirs,
}: {
  field: string;
  base: Tooltip | null;
  mine: Tooltip | null;
  theirs: Tooltip | null;
}) {
  if (field === existsField)
    return (
      <p className={styles.line}>
        {theirs === null
          ? 'Current no longer has this tooltip; the batch would recreate it.'
          : 'Current created this tooltip after the batch staged it.'}
      </p>
    );
  const read = (tooltip: Tooltip | null) => (tooltip ? fieldValue(tooltip, field) : undefined);
  if (field.startsWith('text.')) {
    const text = (tooltip: Tooltip | null) => {
      const value = read(tooltip) as { text?: string } | undefined;
      return value?.text ?? '';
    };
    return <TextBlock base={text(base)} mine={text(mine)} theirs={text(theirs)} />;
  }
  return (
    <p className={styles.line}>
      Batch {short(read(mine))} · current {short(read(theirs))}
    </p>
  );
}

function Choices({
  fields,
  choices,
  labels,
  disabled,
  onChoose,
  render,
}: {
  fields: string[];
  choices: Record<string, ActivationChoice>;
  labels: [string, string];
  disabled: boolean;
  onChoose(field: string, choice: ActivationChoice): void;
  render(field: string): ReactNode;
}) {
  return (
    <>
      {fields.map((field) => (
        <fieldset key={field} className={styles.choice}>
          <legend>{fieldLabel(field)}</legend>
          {render(field)}
          <span className={styles.choiceButtons}>
            {(['upcoming', 'current'] as const).map((value, index) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${field}`}
                  checked={choices[field] === value}
                  disabled={disabled}
                  onChange={() => onChoose(field, value)}
                />
                {labels[index]}
              </label>
            ))}
          </span>
        </fieldset>
      ))}
    </>
  );
}

function MemberRow({
  view,
  batch,
  manage,
  blocked,
  name,
}: {
  view: MemberView;
  batch: Batch;
  manage: boolean;
  blocked: boolean;
  name: string;
}) {
  const data = useDataStore((state) => state.data);
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [choices, setChoices] = useState<Record<string, ActivationChoice>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { member, current, stale } = view;
  const item = data ? itemFor(member.hash, data) : undefined;
  const draft = batch.status === 'draft';
  const needed = useMemo(
    () => (stale.length ? decisionFields(member.base, current, member.proposed) : []),
    [stale, member, current],
  );
  const missing = needed.filter((field) => !choices[field]);

  async function write(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason);
    } finally {
      await refreshBatches();
      setPending(false);
    }
  }

  function rebase() {
    void write(async () => {
      const result = resolveActivation({
        base: member.base,
        current,
        proposed: member.proposed,
        choices,
      });
      if (!result.ok) throw new Error(`Choose for ${fieldList(result.missing)} first.`);
      if (!result.tooltip)
        throw new Error('Nothing left to publish: remove this tooltip from the batch instead.');
      await rebaseMember(batch.id, batch.revision, member.hash, current, result.tooltip);
    });
  }

  const names = () => name;
  return (
    <li
      className={styles.member}
      data-member={member.hash}
      data-stale={stale.length > 0 || undefined}
    >
      <div className={styles.memberHead}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={styles.chevron} aria-hidden="true" />
          <span className={styles.memberName} title={name}>
            {name}
          </span>
        </button>
        <span className={styles.muted}>{member.hash}</span>
        <span className={styles.memberFields}>{fieldList(view.changed) || 'no field changes'}</span>
        {view.first && (
          <small className={styles.mark} title="Never published: the whole tooltip publishes">
            First publication
          </small>
        )}
        {stale.length > 0 && (
          <small className={styles.markWarn} title="Current changed under the batch">
            Stale: {fieldList(stale)}
          </small>
        )}
        <span className={styles.memberEnd}>
          <Link to={`/t/${member.hash}`}>Open ↗</Link>
          {manage && draft && !confirmRemove && (
            <button
              type="button"
              disabled={blocked || pending}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {confirmRemove && (
        <div className={styles.strip} role="group" aria-label={`Confirm removing ${name}`}>
          <span className={styles.confirmText}>
            Remove {name} from the batch? Its staged change is dropped.
          </span>
          <button
            type="button"
            className={styles.danger}
            disabled={blocked || pending}
            onClick={() =>
              void write(() => removeFromBatch(batch.id, batch.revision, [member.hash])).then(() =>
                setConfirmRemove(false),
              )
            }
          >
            {pending ? 'Removing...' : 'Remove'}
          </button>
          <button type="button" disabled={pending} onClick={() => setConfirmRemove(false)}>
            Keep
          </button>
        </div>
      )}
      {view.first && open && (
        <p className={styles.line}>First publication: publishes the whole tooltip.</p>
      )}
      {stale.length > 0 && (
        <div className={styles.stale} data-stale-block>
          <p className={styles.line}>
            Current changed {fieldList(stale)} after this tooltip joined the batch.
            {draft
              ? manage
                ? ' Choose a side for each, then Rebase: the batch then builds on current.'
                : ''
              : ' Unschedule the batch to rebase it.'}
          </p>
          <Choices
            fields={needed.length ? needed : stale}
            choices={choices}
            labels={['Keep batch', 'Use current']}
            disabled={!manage || !draft || blocked || pending}
            onChoose={(field, choice) => setChoices({ ...choices, [field]: choice })}
            render={(field) => (
              <FieldValues
                field={field}
                base={member.base}
                mine={member.proposed}
                theirs={current}
              />
            )}
          />
          {manage && draft && (
            <div className={styles.strip}>
              <button
                type="button"
                className={styles.primary}
                disabled={blocked || pending || missing.length > 0}
                title={missing.length ? `Choose for ${fieldList(missing)}` : undefined}
                onClick={rebase}
              >
                {pending ? 'Rebasing...' : 'Rebase'}
              </button>
            </div>
          )}
        </div>
      )}
      {error !== null && <Refusal error={error} names={names} />}
      {open && (
        <div className={styles.diff}>
          <p className={styles.diffSides}>
            “Previous / live” is current saved; “Current” is this batch's version.
          </p>
          <TooltipDiff before={current} current={view.upcoming} item={item} responsive />
        </div>
      )}
    </li>
  );
}

function ConflictResolver({
  batch,
  conflict,
  manage,
  blocked,
  names,
}: {
  batch: Batch;
  conflict: ActivationConflict;
  manage: boolean;
  blocked: boolean;
  names: (hash: number) => string;
}) {
  const current = useDataStore((state) => state.data?.bundle.tooltips[conflict.hash] ?? null);
  const [choices, setChoices] = useState<Record<string, ActivationChoice>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needed = useMemo(() => {
    const now = decisionFields(conflict.base, current, conflict.proposed);
    return [...new Set([...(now.length ? now : conflict.fields), ...extra])];
  }, [conflict, current, extra]);
  const missing = needed.filter((field) => !choices[field]);
  const automatic = conflict.changed.filter((field) => !needed.includes(field));

  async function resolve() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const expected = current ? await contentHash(current) : null;
      await resolveActivationConflict(batch.id, conflict.hash, expected, choices);
    } catch (reason) {
      const refused = reason as { missing?: string[] };
      if (refused.missing?.length) setExtra(refused.missing);
      setError(reason);
    } finally {
      await refreshBatches();
      setPending(false);
    }
  }

  return (
    <div className={styles.stale} data-conflict={conflict.hash}>
      <p className={styles.line}>
        <b>{names(conflict.hash)}</b> <span className={styles.muted}>{conflict.hash}</span>
        {automatic.length > 0 && <> · applies automatically: {fieldList(automatic)}</>}
      </p>
      <Choices
        fields={needed}
        choices={choices}
        labels={['Apply upcoming', 'Keep current']}
        disabled={!manage || blocked || pending}
        onChoose={(field, choice) => setChoices({ ...choices, [field]: choice })}
        render={(field) => (
          <FieldValues
            field={field}
            base={conflict.base}
            mine={conflict.proposed}
            theirs={current}
          />
        )}
      />
      {manage && (
        <div className={styles.strip}>
          <button
            type="button"
            className={styles.primary}
            disabled={blocked || pending || missing.length > 0}
            title={missing.length ? `Choose for ${fieldList(missing)}` : undefined}
            onClick={() => void resolve()}
          >
            {pending ? 'Resolving...' : 'Resolve'}
          </button>
        </div>
      )}
      {error !== null && <Refusal error={error} names={names} />}
    </div>
  );
}

const shownEvents = 8;

function Events({ batch, head }: { batch: Batch; head: string }) {
  const [all, setAll] = useState(false);
  const [older, setOlder] = useState<BatchEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first event ever is the creation: anything else first means older events were archived.
  const archived = batch.events[0]?.action !== 'create';
  const events = [...(older ?? []), ...batch.events].reverse();
  const visible = all ? events : events.slice(0, shownEvents);
  async function loadOlder() {
    setLoading(true);
    setError(null);
    try {
      setOlder(await readArchivedEvents(head, batch.id));
      setAll(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }
  return (
    <section aria-label="Audit events" className={styles.section}>
      <h3>
        Events ({events.length}
        {archived && !older ? '+' : ''})
      </h3>
      <ol className={styles.events}>
        {visible.map((event, index) => (
          <li key={`${event.at}-${event.revision}-${index}`}>
            <span className={styles.muted}>{at(event.at)}</span> {actor(event.by.login)}{' '}
            {eventLabel(event.action)}
            {event.hashes?.length ? ` · ${plural(event.hashes.length, 'tooltip')}` : ''}
            {event.notBefore ? ` · for ${at(event.notBefore)}` : ''}
            <span className={styles.muted}> · rev {event.revision}</span>
          </li>
        ))}
      </ol>
      <p className={styles.line}>
        {!all && events.length > shownEvents && (
          <button type="button" className={styles.textButton} onClick={() => setAll(true)}>
            Show all {events.length}
          </button>
        )}{' '}
        {archived && !older && (
          <button
            type="button"
            className={styles.textButton}
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            {loading ? 'Loading older events...' : 'Load older events'}
          </button>
        )}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
