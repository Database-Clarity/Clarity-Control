/**
 * Scheduled changes in the editor (spec "Editor UX", Editor bullet; PRODUCT "## Scheduled changes"):
 * when the open tooltip is a member of an open batch, a full-width Current / Upcoming switch sits
 * above the preview and a destination badge in the editor pane header. Upcoming renders the batch's
 * future state (UpcomingSwitch.load.ts); it is read-only, and edits still save to Current.
 *
 * With the build switch OFF (I6) `useUpcoming` is a constant: nothing renders, nothing is requested
 * or stored, and Rollup drops this module's live half and its lazy chunk (the test is inline).
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { languages, type Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import type { Drafts } from '../../services/draftStorage';
import { useAuthStore } from '../../stores/auth';
import { upcomingStore, type OpenBatch, type PreviewSource } from './UpcomingSwitch.store';
import styles from './UpcomingSwitch.module.scss';

export interface UpcomingView {
  /** The switch and its batch line, above the preview; null when the tooltip is in no open batch. */
  control: ReactNode;
  /** The pane header's destination badge; null when the tooltip is in no open batch. */
  badge: ReactNode;
  /** Upcoming is shown: the preview reads this future state instead of Current drafts. */
  overlay: Drafts | undefined;
  /** Upcoming is chosen and its members are still loading. */
  loading: boolean;
}

const off: UpcomingView = { control: null, badge: null, overlay: undefined, loading: false };

let loader: Promise<typeof import('./UpcomingSwitch.load')> | undefined;
// The build-switch test sits on the import itself, so a switch-OFF build never loads the module
// (nor emits the member-parsing worker it creates).
const load = () =>
  (loader ??=
    import.meta.env.VITE_SCHEDULED_ENABLED === '1'
      ? import('./UpcomingSwitch.load')
      : Promise.reject(new Error('Scheduled changes are off')));

const statusLabel: Record<OpenBatch['status'], string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
};

function parts(date: Date, zone: string | undefined, withDay: boolean, year: boolean) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const time = `${values.hour}:${values.minute}`;
  if (!withDay) return time;
  return `${values.weekday} ${values.day} ${values.month}${year ? ` ${values.year}` : ''} ${time}`;
}

/**
 * "Tue 3 Dec 17:00 · 16:00 UTC": the device's zone, then UTC (with its own day when the day
 * differs). The year appears only outside the current one. A device on UTC shows one time.
 */
export function zonedNotBefore(
  iso: string,
  now = new Date(),
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const date = new Date(iso);
  const year = date.getUTCFullYear() !== now.getUTCFullYear();
  const shown = parts(date, zone, true, year);
  const utcDay = parts(date, 'UTC', true, year);
  if (zone === 'UTC' || zone === 'Etc/UTC') return `${utcDay} UTC`;
  const sameDay = utcDay.slice(0, -5) === shown.slice(0, -5);
  return `${shown} · ${sameDay ? parts(date, 'UTC', false, false) : utcDay} UTC`;
}

/** "English", "German", "associations", ... for the fields current changed under the batch. */
function fieldLabel(field: string) {
  if (field === '$exists') return 'existence';
  if (field.startsWith('text.')) {
    const lang = field.slice(5);
    return (languages as readonly string[]).includes(lang) ? languageLabel(lang as Lang) : field;
  }
  return field === 'associated' ? 'associations' : field;
}

function UpcomingControl({
  batch,
  shown,
  stale,
  failed,
  onSource,
  onRetry,
}: {
  batch: OpenBatch;
  shown: PreviewSource;
  stale: readonly string[] | undefined;
  failed: string | undefined;
  onSource(source: PreviewSource): void;
  onRetry(): void;
}) {
  const when = batch.notBefore ? zonedNotBefore(batch.notBefore) : undefined;
  const staleText = stale?.length ? `Current changed: ${stale.map(fieldLabel).join(', ')}` : '';
  const summary = [batch.name, statusLabel[batch.status], when ?? 'No time set']
    .concat(staleText ? [staleText] : [])
    .join(' · ');
  return (
    <div className={styles.upcoming} data-upcoming={shown}>
      <div className={styles.switch} role="group" aria-label="Preview source">
        {(['current', 'upcoming'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={shown === value}
            onClick={() => onSource(value)}
            title={
              value === 'current'
                ? 'The saved tooltip, with your unsaved drafts'
                : `What this tooltip becomes when "${batch.name}" publishes (read-only)`
            }
          >
            {value === 'current' ? 'Current' : 'Upcoming'}
          </button>
        ))}
      </div>
      <p className={styles.line} title={failed ? `${summary}\n${failed}` : summary}>
        {failed ? (
          <>
            <span className={styles.failed}>Upcoming did not load</span>
            <button type="button" className={styles.retry} onClick={onRetry}>
              Retry
            </button>
          </>
        ) : (
          <>
            <span className={styles.name}>{batch.name}</span>
            <span className={styles.meta}>
              {' · '}
              {statusLabel[batch.status]}
              {' · '}
              {batch.notBefore ? (
                <time dateTime={batch.notBefore}>{when}</time>
              ) : (
                <span className={styles.muted}>No time set</span>
              )}
            </span>
            {staleText && <span className={styles.stale}>{` · ${staleText}`}</span>}
          </>
        )}
      </p>
    </div>
  );
}

function DestinationBadge({ batch }: { batch: OpenBatch }) {
  return (
    <span
      className={styles.badge}
      title={`In the open batch "${batch.name}" (${statusLabel[batch.status].toLowerCase()}). Edits here save to Current.`}
    >
      <svg className={styles.clock} viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.75" />
        <path d="M6 3.5V6l1.75 1.25" />
      </svg>
      <span className={styles.badgeText}>
        <span className={styles.badgeWord}>Batch: </span>
        {batch.name}
      </span>
    </span>
  );
}

const roles = new Set(['maintainer', 'editor', 'translator']);

function useUpcomingLive(hash: number, enabled: boolean): UpcomingView {
  const role = useAuthStore((state) => state.user?.role);
  // Trials get no batch access (Q3) and signed-out visitors no listing: nothing is requested.
  const eligible = enabled && role != null && roles.has(role);
  const useStore = upcomingStore();
  useEffect(() => {
    if (!eligible) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void load().then((module) => {
      if (!cancelled) stop = module.startUpcoming();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [eligible]);
  const batch = useStore((state) => (eligible ? state.memberOf[hash] : undefined));
  const source = useStore((state) => state.source);
  const setSource = useStore((state) => state.setSource);
  const batchLoad = useStore((state) => (batch ? state.loads[batch.id] : undefined));
  const wanted = batch !== undefined && source === 'upcoming';
  const batchId = batch?.id;
  const revision = batch?.revision;
  useEffect(() => {
    if (wanted && batchId) void load().then((module) => module.ensureBatch(batchId));
  }, [wanted, batchId, revision]);
  return useMemo(() => {
    if (!batch) return off;
    const ready = batchLoad?.state === 'ready' ? batchLoad.upcoming : undefined;
    const failed =
      batchLoad?.state === 'failed'
        ? batchLoad.error
        : ready && !ready.overlay[hash]
          ? 'This tooltip has no batch file at the listed commit.'
          : undefined;
    // A failed read shows Current (never a stale or empty future) and offers Retry.
    const showing = wanted && !failed ? 'upcoming' : 'current';
    const retry = () => void load().then((module) => module.ensureBatch(batch.id));
    const overlay = showing === 'upcoming' ? ready?.overlay : undefined;
    return {
      control: (
        <UpcomingControl
          batch={batch}
          shown={showing}
          stale={ready?.stale[hash]}
          failed={wanted ? failed : undefined}
          onSource={(next) => {
            setSource(next);
            if (next === 'upcoming' && failed) retry();
          }}
          onRetry={retry}
        />
      ),
      badge: <DestinationBadge batch={batch} />,
      overlay,
      loading: showing === 'upcoming' && !overlay,
    };
  }, [batch, batchLoad, hash, wanted, setSource]);
}

/**
 * The switch, badge, and future state for the open tooltip. `enabled` is false where no switch
 * belongs (archive pages, globals).
 */
export const useUpcoming: (hash: number, enabled: boolean) => UpcomingView =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1' ? useUpcomingLive : () => off;
