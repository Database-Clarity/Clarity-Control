import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { Tooltip } from '@clarity/core';
import type { Item } from '../../services/generator';
import { scaledPx } from '../../ui/scale';
import type { HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { CommitAuthor } from './CommitAuthor';
import { projectHistory, type HistoryScope } from './scope';
import { TooltipDiff } from './TooltipDiff';
import type { RevisionCache, RevisionDiffSource } from './revisions';
import popover from '../../ui/Popover.module.scss';
import styles from './History.module.scss';
import {
  applyPlacement,
  isPhone,
  naturalHeight,
  placeAnchored,
  visibleArea,
} from '../../ui/anchorPlacement';

const HOVER_DELAY = 120;
const LEAVE_DELAY = 160;
const LONG_PRESS = 500;
const OPENED = 'clarity-history-entry-open';

interface AnchorGeometry {
  rect: DOMRect;
  width: number;
}

const measureAnchor = (anchor: HTMLElement | null): AnchorGeometry | undefined =>
  anchor ? { rect: anchor.getBoundingClientRect(), width: scaledPx(480) } : undefined;

export interface HistoryEntryProps {
  scope?: HistoryScope;
  entry: HistoryCommit;
  index: number;
  commits: HistoryCommit[];
  page: number;
  hasMore: boolean;
  cache: RevisionCache;
  /** What the editor holds now: the draft, or the saved tooltip. */
  current?: Tooltip;
  item?: Item;
  /** Translators restore only their languages; shown as a note. */
  translator: boolean;
  /** Restore is offered only when the page may edit and drafts have loaded. */
  canRestore: boolean;
  /** Published artifacts compare the selected state to its next published state. */
  legacy?: boolean;
  /** Replaces the local draft with this revision; throws a readable error when not allowed. */
  onRestore(version: Tooltip): void;
}

/**
 * One history entry. Hovering, focusing, long-pressing or clicking it opens a popover with that
 * revision's diff against its predecessor; a click (or long press) pins it until Esc or a press
 * outside. The popover is fixed-positioned, so it never moves the list.
 */
export const HistoryEntry = memo(function HistoryEntry(props: HistoryEntryProps) {
  const { entry, translator } = props;
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const container = useRef<HTMLLIElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const geometry = useRef<AnchorGeometry | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const timers = useRef<{
    intent?: number;
    enter?: number;
    leave?: number;
    press?: number;
    pointerFocus?: number;
  }>({});
  const pointerFocusing = useRef(false);
  const longPressed = useRef(false);
  const dismissed = useRef(false);
  const id = useId();
  const open = pinned || hover || focus;
  const captureAnchor = () => {
    geometry.current = measureAnchor(container.current);
  };
  const clearTimers = () => {
    window.clearTimeout(timers.current.intent);
    window.clearTimeout(timers.current.enter);
    window.clearTimeout(timers.current.leave);
    window.clearTimeout(timers.current.press);
    window.clearTimeout(timers.current.pointerFocus);
  };
  useEffect(() => clearTimers, []);
  const close = useCallback((restoreFocus: boolean) => {
    window.clearTimeout(timers.current.intent);
    window.clearTimeout(timers.current.enter);
    if (restoreFocus) dismissed.current = true;
    setHover(false);
    setFocus(false);
    setPinned(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    const others = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) return;
      // Cancel pending intent even on closed rows, but do not schedule three
      // redundant React state updates on every row whenever a revision opens.
      if (open) close(false);
      else {
        window.clearTimeout(timers.current.intent);
        window.clearTimeout(timers.current.enter);
      }
    };
    document.addEventListener(OPENED, others);
    return () => document.removeEventListener(OPENED, others);
  }, [open, id, close]);
  useEffect(() => {
    if (open) document.dispatchEvent(new CustomEvent(OPENED, { detail: id }));
  }, [open, id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !container.current?.contains(event.target as Node) &&
        !surface.current?.contains(event.target as Node)
      )
        close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(
        Boolean(
          container.current?.contains(document.activeElement) ||
          surface.current?.contains(document.activeElement),
        ),
      );
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, close]);

  return (
    <li
      ref={container}
      className={styles.entry}
      data-open={open || undefined}
      onMouseEnter={() => {
        window.clearTimeout(timers.current.leave);
        window.clearTimeout(timers.current.intent);
        window.clearTimeout(timers.current.enter);
        timers.current.intent = window.setTimeout(() => {
          void props.cache
            .load(props.commits, props.index, props.page, props.hasMore)
            .catch(() => undefined);
        }, 60);
        timers.current.enter = window.setTimeout(() => {
          captureAnchor();
          setHover(true);
        }, HOVER_DELAY);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timers.current.intent);
        window.clearTimeout(timers.current.enter);
        window.clearTimeout(timers.current.leave);
        timers.current.leave = window.setTimeout(() => setHover(false), LEAVE_DELAY);
        dismissed.current = false;
      }}
      onFocus={() => {
        if (!dismissed.current && !pointerFocusing.current) {
          captureAnchor();
          setFocus(true);
        }
      }}
      onBlur={(event) => {
        if (
          event.currentTarget.contains(event.relatedTarget) ||
          surface.current?.contains(event.relatedTarget as Node)
        )
          return;
        dismissed.current = false;
        setFocus(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={styles.entryButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Show what this revision changed"
        onPointerDown={(event) => {
          // Pointer focus precedes click in the same input task. Opening at both
          // stages renders and lays out the popover twice; keyboard focus still opens it.
          pointerFocusing.current = true;
          window.clearTimeout(timers.current.pointerFocus);
          timers.current.pointerFocus = window.setTimeout(() => {
            pointerFocusing.current = false;
          }, 0);
          longPressed.current = false;
          if (event.pointerType !== 'touch') return;
          window.clearTimeout(timers.current.press);
          timers.current.press = window.setTimeout(() => {
            longPressed.current = true;
            captureAnchor();
            setPinned(true);
          }, LONG_PRESS);
        }}
        onPointerUp={() => window.clearTimeout(timers.current.press)}
        onPointerCancel={() => window.clearTimeout(timers.current.press)}
        onContextMenu={(event) => {
          if (longPressed.current) event.preventDefault();
        }}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          if (pinned) close(false);
          else {
            captureAnchor();
            setPinned(true);
          }
        }}
      >
        <CommitAuthor entry={entry} link={false} />
        <span className={styles.message}>
          {entry.message.split(/\r?\n/, 1)[0]} <code>{entry.commit.slice(0, 8)}</code>
        </span>
      </button>
      {open &&
        createPortal(
          <RevisionPopover
            surface={surface}
            {...props}
            id={id}
            anchor={container}
            initialGeometry={geometry}
            translator={translator}
            pinned={pinned}
            onClose={close}
          />,
          document.body,
        )}
    </li>
  );
});

function RevisionPopover({
  surface,
  id,
  anchor,
  initialGeometry,
  pinned,
  onClose,
  entry,
  index,
  commits,
  page,
  hasMore,
  cache,
  current,
  item,
  translator,
  canRestore,
  onRestore,
  legacy,
  scope,
}: HistoryEntryProps & {
  surface: RefObject<HTMLDivElement>;
  id: string;
  anchor: RefObject<HTMLElement | null>;
  initialGeometry: RefObject<AnchorGeometry | undefined>;
  pinned: boolean;
  onClose(restoreFocus: boolean): void;
}) {
  const [source, setSource] = useState<RevisionDiffSource>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<'previous' | 'current'>('previous');
  const [confirm, setConfirm] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let geometry = initialGeometry.current ?? measureAnchor(anchor.current);
    let measuredHeight = 0;
    const place = () => {
      if (!geometry) return;
      const { rect } = geometry;
      if (isPhone()) {
        // A phone: by the entry, the page width less the edge inset, below it or above it
        // (whichever fits), clear of the keyboard; the shared popover placement.
        applyPlacement(
          element,
          placeAnchored({
            trigger: rect,
            area: visibleArea(window),
            width: Infinity,
            height: naturalHeight(element, element.firstElementChild as HTMLElement | null),
          }),
        );
        return;
      }
      const edge = 8;
      const width = Math.min(geometry.width, window.innerWidth - edge * 2);
      const beside = rect.right + 6 + width <= window.innerWidth - edge;
      const height = Math.min(measuredHeight, window.innerHeight - edge * 2);
      const wanted = beside ? Math.max(edge, rect.top) : rect.bottom + 4;
      // Slide up rather than squash when the entry sits near the bottom of the window.
      const top = Math.min(wanted, window.innerHeight - height - edge);
      // Placement owns only these geometry properties. Updating them directly
      // avoids rendering the entire diff again after each size notification.
      Object.assign(element.style, {
        left: `${beside ? rect.right + 6 : Math.max(edge, window.innerWidth - width - edge)}px`,
        top: `${top}px`,
        // A phone placement held it by its bottom edge (a rotation can switch placements).
        bottom: 'auto',
        width: `${width}px`,
        maxHeight: `${window.innerHeight - edge * 2}px`,
      });
    };
    const refresh = (event?: Event) => {
      if (event?.target instanceof Node && element.contains(event.target)) return;
      geometry = measureAnchor(anchor.current);
      place();
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (!entry) return;
            // Match offsetHeight's border-box rounding without a fresh layout read.
            measuredHeight = Math.round(
              entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight,
            );
            // ResizeObserver runs after layout; read all geometry before writing.
            geometry = measureAnchor(anchor.current);
            place();
          });
    // Only old browsers without ResizeObserver need the synchronous fallback.
    if (!observer) measuredHeight = element.offsetHeight;
    place();
    observer?.observe(element);
    // The visual viewport too: the iOS keyboard and its pan change the room without a resize.
    const viewport = window.visualViewport;
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    viewport?.addEventListener('resize', refresh);
    viewport?.addEventListener('scroll', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      viewport?.removeEventListener('resize', refresh);
      viewport?.removeEventListener('scroll', refresh);
    };
  }, [anchor, initialGeometry, surface]);
  useEffect(() => {
    let live = true;
    setError(undefined);
    cache.load(commits, index, page, hasMore).then(
      (result) => live && setSource(result),
      (reason: unknown) => live && setError(errorMessage(reason)),
    );
    return () => {
      live = false;
    };
    // The entry's own commit identifies the request; the list only grows.
  }, [cache, entry.commit, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown =
    scope && source
      ? {
          ...source,
          revision: projectHistory(source.revision, scope),
          previous: projectHistory(source.previous, scope),
        }
      : source;
  const shownCurrent = scope && current ? projectHistory(current, scope)! : current;

  function restore() {
    if (!source?.revision) return;
    try {
      onRestore(source.revision);
      onClose(false);
    } catch (reason) {
      setRestoreError(errorMessage(reason));
    }
  }

  return (
    <div
      ref={surface}
      id={id}
      role="dialog"
      aria-label={`Revision ${entry.commit.slice(0, 8)}`}
      data-pinned={pinned || undefined}
      className={`${popover.surface} ${styles.revision}`}
    >
      <div className={`${popover.body} ${styles.revisionBody}`}>
        <div className={styles.revisionHead}>
          <span className={styles.revisionTitle}>
            <strong>
              {mode === 'previous'
                ? legacy
                  ? 'Published text → next published state'
                  : 'Changed in this revision'
                : 'Compared with current'}
            </strong>
            <span>
              <CommitAuthor entry={entry} /> <code>{entry.commit.slice(0, 8)}</code>
            </span>
            {legacy && mode === 'previous' && index > 0 && (
              <span>
                Next published state: <CommitAuthor entry={commits[index - 1]} />{' '}
                <code>{commits[index - 1].commit.slice(0, 8)}</code>
              </span>
            )}
          </span>
          <button
            type="button"
            aria-pressed={mode === 'current'}
            disabled={!current || !source}
            title="Compare this revision with the current draft"
            onClick={() => setMode(mode === 'current' ? 'previous' : 'current')}
          >
            vs current draft
          </button>
        </div>
        {error && (
          <p role="alert">
            {error}{' '}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          </p>
        )}
        {!source && !error && <p role="status">Loading revision...</p>}
        {shown &&
          (legacy && mode === 'previous' ? (
            shown.hasPredecessor ? (
              <TooltipDiff
                before={shown.revision}
                current={
                  shown.previous ?? { hash: shownCurrent?.hash ?? 0, text: {}, associated: [] }
                }
                raw={false}
                eagerLanguages
              />
            ) : (
              <p>
                Last published state before migration. Compare with the current draft to see later
                changes.
              </p>
            )
          ) : mode === 'previous' ? (
            <>
              {!shown.revision ? (
                <p>Deleted in this revision.</p>
              ) : (
                !shown.previous && (
                  <p>
                    {shown.hasPredecessor
                      ? 'Restored in this revision.'
                      : 'First revision: everything is new.'}
                  </p>
                )
              )}
              <TooltipDiff
                before={shown.previous}
                current={
                  shown.revision ?? { hash: shown.previous?.hash ?? 0, text: {}, associated: [] }
                }
                item={item}
                raw={false}
              />
            </>
          ) : (
            shownCurrent && (
              <TooltipDiff
                before={shown.revision}
                current={
                  legacy
                    ? { hash: shownCurrent.hash, text: shownCurrent.text, associated: [] }
                    : shownCurrent
                }
                item={item}
                raw={false}
                eagerLanguages={legacy}
              />
            )
          ))}
        {source?.revision && canRestore && (
          <div className={styles.revisionActions}>
            {legacy && <p>Only language text is restored. Other tooltip fields stay unchanged.</p>}
            {translator && (
              <p>
                Restore replaces only the shown, assigned translation language; other fields stay
                unchanged.
              </p>
            )}
            {restoreError && <p role="alert">{restoreError}</p>}
            {!confirm ? (
              <button type="button" onClick={() => setConfirm(true)}>
                Restore this revision
              </button>
            ) : (
              <>
                <p>
                  Restore this version as a new draft? This replaces your local edits without saving
                  or pushing.
                </p>
                <span className={styles.confirmRow}>
                  <button type="button" onClick={restore}>
                    Load as draft
                  </button>
                  <button type="button" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
