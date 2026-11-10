import { memo, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
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
  const { language, state, category, query } = context;
  const rows = useMemo(
    () => (data ? queueFor(translationIndex(data), language, { state, category, query }) : noRows),
    [data, language, state, category, query],
  );
  const view = `${language}|${state}|${category}|${query}`;
  const anchor = useRef<QueueAnchor & { view: string }>();
  const place = useMemo(() => {
    const kept = anchor.current?.view === view ? anchor.current : undefined;
    return queuePlace(rows, hash, kept);
  }, [rows, hash, view]);
  useEffect(() => {
    if (place.index) anchor.current = { view, hash, rows, index: place.index - 1 };
  }, [place, view, hash, rows]);

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

  const linkState = useMemo(() => queueState({ state, category, query }), [state, category, query]);
  const step = (
    row: QueueRow | undefined,
    ref: typeof next,
    label: string,
    keys: string,
    glyph: ReactNode,
  ) => {
    const to = row && entryPath(row);
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      // The finder's own order for a jump: ask the guard, then let the editor and header paint
      // before the preview and the side pane. A refused step changes nothing (the router's
      // blocker shows the prompt).
      if (!usePreviewReviewStore.getState().leaveBlocked(pathname, `/t/${row!.hash}`))
        pulseStepping();
    };
    return to ? (
      <Link
        ref={ref}
        to={to}
        state={linkState}
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

  return (
    <span className={styles.queue} role="group" aria-label="Translation queue" data-queue>
      <Link
        to={queuePath(context, user)}
        className={styles.queueBack}
        title="Back to the translation queue, with its filters"
      >
        Queue
      </Link>
      <span className={styles.queuePosition} role="status">
        {placeLabel(place)}
      </span>
      {place.total > 0 && (
        <>
          {step(place.previous, previous, 'Previous in queue', 'Alt+PageUp', '‹')}
          {step(place.next, next, 'Next in queue', 'Alt+PageDown', '›')}
        </>
      )}
    </span>
  );
});
