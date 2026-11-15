/**
 * Scheduled changes in the editor (spec "Editor UX", Editor bullet; PRODUCT "## Scheduled changes"):
 * when the open tooltip is a member of an open batch, a full-width Current / Upcoming switch sits
 * above the preview and a destination badge in the editor pane header. Upcoming renders the batch's
 * future state (UpcomingSwitch.load.ts); it is read-only, and edits still save to Current.
 *
 * With the build switch OFF (I6) `useUpcoming` is a constant: nothing renders, nothing is requested
 * or stored, and Rollup drops this module's live half and its lazy chunk (the test is inline).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { languages, type Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import type { Drafts } from '../../services/draftStorage';
import { zonedNotBefore } from '../../services/format/date';
import { useAuthStore } from '../../stores/auth';
import { upcomingStore, type OpenBatch, type PreviewSource } from './UpcomingSwitch.store';
import styles from './UpcomingSwitch.module.scss';
import { useBatchEditing, type BatchDestination, type BatchEditing } from './batchDestination';

export interface UpcomingView {
  /** The switch and its batch line, above the preview; null when the tooltip is in no open batch. */
  control: ReactNode;
  /** The pane header's destination badge; null when the tooltip is in no open batch. */
  badge: ReactNode;
  /** Upcoming is shown: the preview reads this future state instead of Current drafts. */
  overlay: Drafts | undefined;
  /** Upcoming is chosen and its members are still loading. */
  loading: boolean;
  editing?: BatchEditing;
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
          // Segments wrap as wholes (never inside a time). Each draws its "·" before it, and the
          // row starts one separator to the left inside a clipped line, so a separator never
          // dangles at the start or end of a wrapped line.
          <span className={styles.clip}>
            <span className={styles.segments}>
              <span className={`${styles.segment} ${styles.name}`}>{batch.name}</span>
              <span className={styles.segment}>{statusLabel[batch.status]}</span>
              {batch.notBefore ? (
                <time className={styles.segment} dateTime={batch.notBefore}>
                  {when}
                </time>
              ) : (
                <span className={`${styles.segment} ${styles.muted}`}>No time set</span>
              )}
              {staleText && (
                <span className={`${styles.segment} ${styles.stale}`}>{staleText}</span>
              )}
            </span>
          </span>
        )}
      </p>
    </div>
  );
}

type BadgeMode = 'name' | 'clock' | 'none';

/**
 * The pane header badge: clock + batch name while the whole name fits; otherwise the clock alone
 * (the name stays in the title and for screen readers); and nothing when even the clock would push
 * the header's controls out of the row (the batch line above the preview still names the batch).
 * It never draws under the controls beside it. Fit is measured when the header or the badge
 * resizes, when the header's controls change, and when the name changes, never per keystroke.
 */
function DestinationBadge({
  batch,
  destination = false,
}: {
  batch: OpenBatch;
  destination?: boolean;
}) {
  const badge = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<BadgeMode>('name');
  useLayoutEffect(() => {
    const element = badge.current;
    const header = element?.parentElement;
    if (!element || !header || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      // Lay the badge out in each candidate mode, read whether it fits, then let React apply it.
      const text = element.lastElementChild as HTMLElement;
      element.dataset.measure = 'name';
      let next: BadgeMode = text.scrollWidth <= text.clientWidth + 1 ? 'name' : 'clock';
      if (next === 'clock') {
        element.dataset.measure = 'clock';
        if (header.scrollWidth > header.clientWidth + 1) next = 'none';
      }
      delete element.dataset.measure;
      setMode(next);
    };
    // The observer's first callback (after layout, before paint) measures; no forced layout here.
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(element);
    // Controls that join the header later (the draft dot, translation-mode buttons) take room
    // without resizing it: re-measure when its children change (rare, never per keystroke).
    const children = new MutationObserver(measure);
    children.observe(header, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, [batch.name]);
  return (
    <span
      ref={badge}
      className={`${styles.badge} ${destination ? styles.destination : ''}`}
      data-mode={mode}
      title={`In the open batch "${batch.name}" (${statusLabel[batch.status].toLowerCase()}). Edits here save to ${destination ? batch.name : 'Current'}.`}
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

function useUpcomingLive(
  hashes: readonly number[],
  enabled: boolean,
  destination?: BatchDestination,
): UpcomingView {
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
  // The first of the page's tooltips (its base, then its versions) that an open batch holds.
  const hash = useStore((state) =>
    eligible ? hashes.find((candidate) => state.memberOf[candidate] !== undefined) : undefined,
  );
  const batch = useStore((state) =>
    destination
      ? Object.values(state.memberOf).find((batch) => batch.id === destination.batchId)
      : hash !== undefined
        ? state.memberOf[hash]
        : undefined,
  );
  const source = useStore((state) => state.source);
  const setSource = useStore((state) => state.setSource);
  const batchLoad = useStore((state) => (batch ? state.loads[batch.id] : undefined));
  const listFailed = useStore((state) => state.listFailed);
  const listed = useStore((state) => state.head !== null);
  const editing = useBatchEditing(
    destination,
    batch,
    batchLoad,
    eligible,
    listFailed,
    listed,
    () => {
      if (!eligible || !destination) return;
      void load().then(async (module) => {
        await module.refreshBatches();
        module.ensureBatch(destination.batchId);
      });
    },
  );
  const wanted = batch !== undefined && (source === 'upcoming' || !!destination);
  const batchId = batch?.id;
  const revision = batch?.revision;
  useEffect(() => {
    if (wanted && batchId) void load().then((module) => module.ensureBatch(batchId));
  }, [wanted, batchId, revision]);
  return useMemo(() => {
    if (!batch || hash === undefined) return { ...off, editing };
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
      control: destination ? (
        <p className={styles.line}>
          Batch: {statusLabel[batch.status]}
          {batch.notBefore ? ` · ${zonedNotBefore(batch.notBefore)}` : ' · No time set'}
        </p>
      ) : (
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
      badge: <DestinationBadge batch={batch} destination={!!destination} />,
      editing,
      overlay,
      loading: showing === 'upcoming' && !overlay,
    };
  }, [batch, batchLoad, hash, wanted, setSource, destination, editing]);
}

/**
 * The switch, badge, and future state for the open page's tooltips (`hashes`: its base, then its
 * versions). `enabled` is false where no switch belongs (archive pages, globals).
 */
export const useUpcoming: (
  hashes: readonly number[],
  enabled: boolean,
  destination?: BatchDestination,
) => UpcomingView = import.meta.env.VITE_SCHEDULED_ENABLED === '1' ? useUpcomingLive : () => off;
