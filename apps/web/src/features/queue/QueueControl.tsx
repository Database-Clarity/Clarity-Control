import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { useDraftStore } from '../../stores/drafts';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { Popover } from '../../ui/Popover';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { pulseStepping, useSteppingActivity } from '../navigation/steppingActivity';
import {
  firstToDo,
  placeLabel,
  queuePlace,
  statusOf,
  visitState,
  type QueueItem,
  type QueuePlace,
  type QueueVisit,
  type WorkQueue,
} from './model';
import { queueSources } from './sources';
import { takeEntryFocus } from './start';
import { withEditorPaths } from './editorPath';
import { useWorkQueues } from './store';
import { useQueueDone, useSourceContext, type WorkThrough } from './useQueue';
import { pendingVisit, publishQueueStepper } from './worklistStepping';
import header from '../tooltip/TooltipPage.module.scss';
import styles from './QueueControl.module.scss';

const DriftPanel = lazy(() => import('./DriftPanel'));
const LostPanel = lazy(() => import('./LostPanel'));

/** The source's own finishing action, beside the queue: what each list calls done. */
const panels: Partial<
  Record<WorkQueue['source'], { label: string; short: string; title: string }>
> = {
  drift: {
    label: 'Bungie change',
    short: 'Change',
    title: 'The in-game description change, and Mark reviewed',
  },
  'lost-text': {
    label: 'Earlier text',
    short: 'Earlier',
    title: 'The earlier text, Recover as draft, and Dismiss',
  },
};

function Panel({ queue, item }: { queue: WorkQueue; item: QueueItem }) {
  return (
    <Suspense fallback={<p className={styles.loading}>Loading…</p>}>
      {queue.source === 'drift' ? (
        <DriftPanel item={item} />
      ) : queue.source === 'lost-text' ? (
        <LostPanel item={item} />
      ) : null}
    </Suspense>
  );
}

/**
 * The way back to the list: its filters, selection, and scroll come back with it. The queue ends
 * when the list receives this state (`useLeftQueue`), so a Leave the leave guard refuses, or one
 * opened in another tab, changes nothing.
 */
export function leaveTarget(queue: WorkQueue) {
  return {
    to: queue.origin.path,
    state: { workThroughReturn: queue.origin.restore, workThroughLeft: queue.id },
  };
}

/**
 * A work-through queue's control in the editor's pane header (the translator queue's pattern):
 * the list it came from (the way back), the position ("12 of 148", a menu of every item with
 * Rebuild queue), the list's own finishing action, and Previous and Next (Alt+PageUp and
 * Alt+PageDown). Previous and Next are plain links, so the leave guard, drafts, and conflicts
 * treat them like any other navigation. Paused (an ordinary visit while the tab works through a
 * queue): the name and Resume.
 */
export const WorkThroughControl = memo(function WorkThroughControl({
  work,
  actions,
}: {
  work: WorkThrough;
  actions?: ReactNode;
}) {
  return work.mode === 'active' ? (
    <ActiveControl queue={work.queue} visit={work.visit} actions={actions} />
  ) : (
    <PausedControl queue={work.queue} />
  );
});

function useStepKeys() {
  const previous = useRef<HTMLElement>(null);
  const next = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
      if (workspaceShortcutsBlocked(event)) return;
      event.preventDefault();
      // A click on the control itself: one path for the mouse and the keyboard.
      (event.key === 'PageDown' ? next : previous).current?.click();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return { previous, next };
}

function ActiveControl({
  queue,
  visit,
  actions,
}: {
  queue: WorkQueue;
  visit: QueueVisit;
  actions?: ReactNode;
}) {
  const isDone = useQueueDone(queue);
  const { pathname, key: entry } = useLocation();
  const phone = useMedia(phoneQuery);
  const source = queueSources[queue.source];
  // A worklist gesture (Shift+wheel, the finder's arrows) shows its newest item with the header
  // and editor, before the route lands.
  const pending = pendingVisit(useSteppingActivity((state) => state.target));
  const shownKey = pending?.id === queue.id ? pending.key : visit.key;
  const place = queuePlace(queue, shownKey, isDone);
  const { previous, next } = useStepKeys();

  // The finder steps this queue while it is on screen (worklist stepping); Archive has no finder.
  // A new visit replaces the published one in place; only unmounting withdraws it.
  const withdraw = useRef<() => void>();
  useLayoutEffect(() => {
    if (queue.source === 'archive') return;
    withdraw.current = publishQueueStepper({
      queue,
      visit: { id: visit.id, key: visit.key },
      isDone,
    });
  }, [queue, visit.id, visit.key, isDone]);
  useLayoutEffect(() => () => withdraw.current?.(), []);

  // Opening an item makes it the queue's current one; Next past an open item skips it.
  const visitItem = useWorkQueues((state) => state.visit);
  const finish = useWorkQueues((state) => state.finish);
  const revisit = useWorkQueues((state) => state.revisit);
  const passedRef = useRef({ queue, isDone });
  passedRef.current = { queue, isDone };
  useEffect(() => {
    // Revisit applies once its item opens (a refused or new-tab Revisit changes nothing). Each
    // history entry counts: Finish stays on its item, so a second Revisit of that item arrives
    // with the same queue, item, and flag, only a new entry.
    if (visit.revisit) revisit(visit.id);
    const { queue: latest, isDone: done } = passedRef.current;
    const passed = latest.items.find((item) => item.key === latest.current);
    visitItem(visit.id, visit.key, Boolean(passed && !done(passed)));
  }, [entry, visit.id, visit.key, visit.revisit, visitItem, revisit]);

  const label = placeLabel(place);
  const name = `${source.label}${queue.destination ? ` · ${queue.destination.batchName}` : ''} queue`;
  const leave = leaveTarget(queue);

  const step = (
    item: QueueItem | undefined,
    ref: typeof next,
    text: string,
    keys: string,
    glyph: ReactNode,
  ) => {
    const to = item && source.path(item);
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      // The finder's own order for a jump: ask the guard, then let the editor and header paint
      // before the preview and the side pane. A refused step changes nothing.
      if (!usePreviewReviewStore.getState().leaveBlocked(pathname, to!.split('?')[0]!))
        pulseStepping();
    };
    return to ? (
      <Link
        ref={ref as React.RefObject<HTMLAnchorElement>}
        to={to}
        state={visitState({ id: queue.id, key: item.key })}
        className={header.queueStep}
        aria-label={`${text}: ${item.name}`}
        aria-keyshortcuts={keys}
        title={`${text}: ${item.name} (${keys.replace('Page', 'Page ')})`}
        data-perf-navigation="true"
        onClick={onClick}
      >
        {glyph}
      </Link>
    ) : null;
  };
  const previousStep = step(place.previous, previous, 'Previous in queue', 'Alt+PageUp', '‹') ?? (
    <span
      className={header.queueStep}
      role="link"
      aria-label="Previous in queue"
      aria-disabled="true"
    >
      ‹
    </span>
  );
  // Next on the last item ends the queue here (the item counts as skipped while still open).
  const nextStep = step(place.next, next, 'Next in queue', 'Alt+PageDown', '›') ?? (
    <button
      ref={next as React.RefObject<HTMLButtonElement>}
      type="button"
      className={header.queueStep}
      aria-label="Finish the queue"
      aria-keyshortcuts="Alt+PageDown"
      title="Finish the queue: the last item (Alt+Page Down)"
      onClick={() => finish(queue.id, visit.key, place.status === 'open')}
    >
      ›
    </button>
  );
  const revisitItem = place.finished && place.left ? firstToDo(queue, isDone) : undefined;
  const revisitLink = revisitItem && (
    <Link
      to={source.path(revisitItem)}
      state={visitState({ id: queue.id, key: revisitItem.key, revisit: true })}
      className={header.queueBack}
      title={`Back to the first item left: ${revisitItem.name}`}
    >
      Revisit
    </Link>
  );
  // Leave: the source list's name on desktop; on phones it is in the menu (Leave queue).
  const back = (text: string, ariaLabel?: string) => (
    <Link
      to={leave.to}
      state={leave.state}
      className={header.queueBack}
      aria-label={ariaLabel}
      title={`Leave the queue: back to ${source.label}, with its filters and selection`}
    >
      {text}
    </Link>
  );
  // Starting a queue puts focus on its position menu (a keyboard user lands on the queue).
  const group = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (takeEntryFocus(queue.id))
      group.current
        ?.querySelector<HTMLButtonElement>('button[aria-haspopup]')
        ?.focus({ preventScroll: true });
  }, [queue.id]);
  const finished = place.finished ? (place.skipped ? 'skipped' : 'done') : undefined;
  const menu = (trigger: ReactNode, className: string) => (
    <Popover
      label={name}
      className={className}
      flush
      bodyClassName={styles.menuBody}
      width={360}
      trigger={trigger}
      triggerLabel={`${name}: ${label}`}
      triggerTitle={`${source.label}: every item in this queue, and Rebuild queue`}
    >
      {(close) => (
        <QueueMenu
          queue={queue}
          place={place}
          visit={visit}
          isDone={isDone}
          close={close}
          panel={phone && panels[queue.source] ? place.current : undefined}
        />
      )}
    </Popover>
  );
  const panel = panels[queue.source];
  const panelButton = !phone && panel && place.current && (
    <Popover
      label={panel.label}
      className={header.queueBack}
      width={480}
      trigger={
        // A narrow header shows the short word (its title still says it all).
        <>
          <span className={styles.long}>{panel.label}</span>
          <span className={styles.short} aria-hidden="true">
            {panel.short}
          </span>
        </>
      }
      triggerLabel={panel.label}
      triggerTitle={panel.title}
    >
      <Panel queue={queue} item={place.current} />
    </Popover>
  );

  // Phones: one joined stepper `[‹][12 of 148 ▾][›]`; the position opens the same menu as on a
  // desktop (every item, Rebuild queue, Leave queue).
  const phoneMenu = menu(
    <>
      <span>{label}</span>
      <span className={styles.chevron} aria-hidden="true" />
    </>,
    `${header.queueBack} ${styles.phonePosition}`,
  );
  if (phone)
    return (
      <>
        <span className="sr-only" role="status">
          {label}
        </span>
        <span
          ref={group}
          className={`${header.queue} ${header.queueStepper} ${styles.queue}`}
          role="group"
          aria-label={name}
          data-queue
          data-batch={queue.destination ? '' : undefined}
          data-finished={finished}
        >
          {place.finished ? (
            <>
              {phoneMenu}
              {revisitLink}
            </>
          ) : (
            <>
              {previousStep}
              {phoneMenu}
              {nextStep}
            </>
          )}
        </span>
      </>
    );
  return (
    <span
      ref={group}
      className={`${header.queue} ${styles.queue}`}
      role="group"
      aria-label={name}
      data-queue
      data-finished={finished}
    >
      {back(queue.destination?.batchName ?? source.label)}
      {menu(
        <>
          <span role="status">{label}</span>
          <span className={styles.chevron} aria-hidden="true" />
        </>,
        `${header.queuePosition} ${styles.position}`,
      )}
      {actions}
      {place.finished ? (
        revisitLink
      ) : (
        <>
          {panelButton}
          {previousStep}
          {nextStep}
        </>
      )}
    </span>
  );
}

/** Every item with its status, a jump to any of them, Rebuild queue, and Leave. */
function QueueMenu({
  queue,
  place,
  visit,
  isDone,
  close,
  panel,
}: {
  queue: WorkQueue;
  place: QueuePlace;
  visit: QueueVisit;
  isDone: (item: QueueItem) => boolean;
  close(restoreFocus?: boolean): void;
  /** Phones: the source's finishing action for this item sits at the top of the menu. */
  panel?: QueueItem;
}) {
  const source = queueSources[queue.source];
  const context = useSourceContext();
  const rebuild = useWorkQueues((state) => state.rebuild);
  const [rebuilding, setRebuilding] = useState<'idle' | 'busy' | string>('idle');
  const leave = leaveTarget(queue);
  const done = queue.items.filter(isDone).length;
  const current = useRef<HTMLLIElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  async function onRebuild() {
    if (!context) return;
    setRebuilding('busy');
    try {
      const before = new Set(queue.items.map((item) => item.key));
      const items = await source.rebuild(queue, context, useDraftStore.getState().drafts);
      const added = items.filter((item) => !before.has(item.key)).length;
      const gone = before.size - (items.length - added);
      rebuild(queue.id, withEditorPaths(queue.source, items, context.data));
      setRebuilding(`Rebuilt: ${items.length} items, ${added} new, ${gone} gone.`);
    } catch {
      setRebuilding('The list could not be read again. Try again.');
    }
  }
  return (
    <div className={styles.menu}>
      {panel && (
        <section className={styles.menuPanel} aria-label={panels[queue.source]!.label}>
          <h3>{panels[queue.source]!.label}</h3>
          <Panel queue={queue} item={panel} />
        </section>
      )}
      <header className={styles.menuHead}>
        <strong>{queue.destination?.batchName ?? source.label}</strong>
        <span>
          {queue.items.length} {queue.scope === 'selected' ? 'selected' : 'shown'} · {done} done
          {place.skipped ? ` · ${place.skipped} skipped` : ''}
        </span>
      </header>
      <ol className={styles.items}>
        {queue.items.map((item) => {
          const status = statusOf(queue, item, isDone);
          const here = item.key === visit.key;
          return (
            <li key={item.key} ref={here ? current : undefined} data-status={status}>
              <Link
                to={source.path(item)}
                state={visitState({ id: queue.id, key: item.key })}
                aria-current={here ? 'page' : undefined}
                onClick={() => close(false)}
              >
                <span className={styles.mark} aria-hidden="true" />
                <span className={styles.name}>{item.name}</span>
                {item.lang && <span className={styles.meta}>{item.lang}</span>}
                <span className={styles.meta}>
                  {status === 'done' ? 'Done' : status === 'skipped' ? 'Skipped' : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <footer className={styles.menuFoot}>
        <button
          type="button"
          disabled={rebuilding === 'busy' || !context}
          title="Read the list again with the same filters: new matches join, finished ones leave"
          onClick={() => void onRebuild()}
        >
          {rebuilding === 'busy' ? 'Rebuilding…' : 'Rebuild queue'}
        </button>
        <Link to={leave.to} state={leave.state} onClick={() => close(false)}>
          Leave queue
        </Link>
        {rebuilding !== 'idle' && rebuilding !== 'busy' && (
          <span role="status" className={styles.note}>
            {rebuilding}
          </span>
        )}
      </footer>
    </div>
  );
}

/** An ordinary visit while the tab works through a queue: its name, Resume, and End. */
function PausedControl({ queue }: { queue: WorkQueue }) {
  const isDone = useQueueDone(queue);
  const end = useWorkQueues((state) => state.end);
  const source = queueSources[queue.source];
  const place = queuePlace(queue, queue.current, isDone);
  if (!place.left) return null;
  const item = place.current && !isDone(place.current) ? place.current : firstToDo(queue, isDone);
  if (!item) return null;
  return (
    <span
      className={`${header.queue} ${styles.queue}`}
      role="group"
      aria-label={`${source.label}${queue.destination ? ` · ${queue.destination.batchName}` : ''} queue, paused`}
      data-queue
      data-paused
    >
      <span className={`${header.queuePosition} ${styles.paused}`} role="status">
        {queue.destination?.batchName ?? source.label} · paused
      </span>
      {/* Phones: one joined pair at the stepper's height. */}
      <span className={styles.pausedActions}>
        <Link
          to={source.path(item)}
          state={visitState({ id: queue.id, key: item.key })}
          className={header.queueBack}
          title={`Back to the queue: ${item.name}`}
        >
          Resume
        </Link>
        <button
          type="button"
          className={header.queueBack}
          title="Stop working through this queue"
          onClick={() => end(queue.id)}
        >
          End
        </button>
      </span>
    </span>
  );
}
