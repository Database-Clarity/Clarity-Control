import { memo, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { canonicalHash } from '../navigation/catalog';
import { pulseStepping } from '../navigation/steppingActivity';
import { queueFor, translationIndex, type QueueRow } from '../translations/queue';
import { placeLabel, queuePlace, type QueueAnchor } from '../translations/queuePlace';
import { entryPath, queuePath, queueState, type QueueContext } from '../translations/worklist';
import styles from './TooltipPage.module.scss';

const noRows: readonly QueueRow[] = [];

/**
 * Queue mode's control in the editor's pane header: the position in the Translations queue this
 * tooltip was opened from, Previous and Next, and the way back to that queue. It exists only with
 * a queue context in the history entry's state (the tab's filters), never on an ordinary visit.
 *
 * The list is the tab's own (`queueFor`), read from the loaded data on every render, so a saved
 * translation leaves it at once. Previous and Next are plain links: the leave guard, drafts and
 * conflicts treat them like any other navigation. Alt+PageDown and Alt+PageUp press them.
 */
export const QueueControl = memo(function QueueControl({
  hash,
  context,
}: {
  /** The open tooltip (canonical). */
  hash: number;
  context: QueueContext;
}) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const { pathname } = useLocation();
  const phone = useMedia(phoneQuery);
  const { language, state, category, query, at } = context;
  // An override's row is shown on its base's page: the row the visit was opened for is the place.
  const current = at !== undefined && data && canonicalHash(at, data) === hash ? at : hash;
  const rows = useMemo(
    () => (data ? queueFor(translationIndex(data), language, { state, category, query }) : noRows),
    [data, language, state, category, query],
  );
  const view = `${language}|${state}|${category}|${query}`;
  const anchor = useRef<QueueAnchor & { view: string }>();
  const place = useMemo(() => {
    const kept = anchor.current?.view === view ? anchor.current : undefined;
    return queuePlace(rows, current, kept);
  }, [rows, current, view]);
  useEffect(() => {
    if (place.index) anchor.current = { view, hash: current, rows, index: place.index - 1 };
  }, [place, view, current, rows]);

  const previous = useRef<HTMLAnchorElement>(null);
  const next = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
      if (workspaceShortcutsBlocked(event)) return;
      event.preventDefault();
      // A click on the link itself: one path for the mouse and the keyboard.
      (event.key === 'PageDown' ? next : previous).current?.click();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const step = (
    row: QueueRow | undefined,
    ref: typeof next,
    label: string,
    keys: string,
    glyph: ReactNode,
  ) => {
    const to = row && entryPath(row, data ? canonicalHash(row.hash, data) : row.hash);
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      // The finder's own order for a jump: ask the guard, then let the editor and header paint
      // before the preview and the side pane. A refused step changes nothing (the router's
      // blocker shows the prompt).
      if (!usePreviewReviewStore.getState().leaveBlocked(pathname, to!.split('?')[0]!))
        pulseStepping();
    };
    return to ? (
      <Link
        ref={ref}
        to={to}
        state={queueState({ state, category, query }, row.hash)}
        className={styles.queueStep}
        aria-label={`${label}: ${row.name}`}
        aria-keyshortcuts={keys}
        title={`${label}: ${row.name} (${keys.replace('Page', 'Page ')})`}
        data-perf-navigation="true"
        onClick={onClick}
      >
        {glyph}
      </Link>
    ) : (
      <span className={styles.queueStep} role="link" aria-label={label} aria-disabled="true">
        {glyph}
      </span>
    );
  };

  const done = place.total === 0;
  const label = placeLabel(place);
  if (phone) {
    // Phones: one joined stepper `[‹][12 of 148][›]`; the middle segment is the way back to the
    // queue and reads the position. The status line stays for screen readers only, outside the joined
    // group so the group's first and last segments are the visible ones.
    return (
      <>
        <span className="sr-only" role="status">
          {label}
        </span>
        <span
          className={`${styles.queue} ${styles.queueStepper}`}
          role="group"
          aria-label="Translation queue"
          data-queue
        >
          {done ? (
            <Link
              to={queuePath(context, user)}
              className={styles.queueBack}
              title="Back to the translation queue, with its filters"
            >
              Back to queue
            </Link>
          ) : (
            <>
              {step(place.previous, previous, 'Previous in queue', 'Alt+PageUp', '‹')}
              <Link
                to={queuePath(context, user)}
                className={styles.queueBack}
                aria-label={`Back to the translation queue, ${label}`}
                title="Back to the translation queue, with its filters"
              >
                {label}
              </Link>
              {step(place.next, next, 'Next in queue', 'Alt+PageDown', '›')}
            </>
          )}
        </span>
      </>
    );
  }
  const back = (
    <Link
      to={queuePath(context, user)}
      className={styles.queueBack}
      title="Back to the translation queue, with its filters"
    >
      {done ? 'Back to queue' : 'Queue'}
    </Link>
  );
  return (
    <span className={styles.queue} role="group" aria-label="Translation queue" data-queue>
      {!done && back}
      <span className={styles.queuePosition} role="status">
        {label}
      </span>
      {done ? (
        back
      ) : (
        <>
          {step(place.previous, previous, 'Previous in queue', 'Alt+PageUp', '‹')}
          {step(place.next, next, 'Next in queue', 'Alt+PageDown', '›')}
        </>
      )}
    </span>
  );
});
