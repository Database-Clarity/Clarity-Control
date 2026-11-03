import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { Tooltip } from '@clarity/core';
import type { Item } from '../../services/generator';
import { scaledPx } from '../../ui/scale';
import type { HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { CommitAuthor } from './CommitAuthor';
import { TooltipDiff } from './TooltipDiff';
import type { RevisionCache, RevisionDiffSource } from './revisions';
import popover from '../../ui/Popover.module.scss';
import styles from './History.module.scss';

const HOVER_DELAY = 200;
const LEAVE_DELAY = 160;
const LONG_PRESS = 500;

export interface HistoryEntryProps {
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
  /** Replaces the local draft with this revision; throws a readable error when not allowed. */
  onRestore(version: Tooltip): void;
}

/**
 * One history entry. Hovering, focusing, long-pressing or clicking it opens a popover with that
 * revision's diff against its predecessor; a click (or long press) pins it until Esc or a press
 * outside. The popover is fixed-positioned, so it never moves the list.
 */
export function HistoryEntry(props: HistoryEntryProps) {
  const { entry, translator } = props;
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const container = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timers = useRef<{ enter?: number; leave?: number; press?: number }>({});
  const longPressed = useRef(false);
  const id = useId();
  const open = pinned || hover || focus;
  const clearTimers = () => {
    window.clearTimeout(timers.current.enter);
    window.clearTimeout(timers.current.leave);
    window.clearTimeout(timers.current.press);
  };
  useEffect(() => clearTimers, []);
  const close = useCallback((restoreFocus: boolean) => {
    window.clearTimeout(timers.current.enter);
    setHover(false);
    setFocus(false);
    setPinned(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(container.current?.contains(document.activeElement) ?? false);
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
        window.clearTimeout(timers.current.enter);
        timers.current.enter = window.setTimeout(() => setHover(true), HOVER_DELAY);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timers.current.enter);
        window.clearTimeout(timers.current.leave);
        timers.current.leave = window.setTimeout(() => setHover(false), LEAVE_DELAY);
      }}
      onFocus={() => setFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
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
          longPressed.current = false;
          if (event.pointerType !== 'touch') return;
          window.clearTimeout(timers.current.press);
          timers.current.press = window.setTimeout(() => {
            longPressed.current = true;
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
          else setPinned(true);
        }}
      >
        <CommitAuthor entry={entry} />
        <span className={styles.message}>
          {entry.message} <code>{entry.commit.slice(0, 8)}</code>
        </span>
      </button>
      {open && (
        <RevisionPopover
          {...props}
          id={id}
          anchor={container}
          translator={translator}
          pinned={pinned}
          onClose={close}
        />
      )}
    </li>
  );
}

function RevisionPopover({
  id,
  anchor,
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
}: HistoryEntryProps & {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  pinned: boolean;
  onClose(restoreFocus: boolean): void;
}) {
  const [style, setStyle] = useState<CSSProperties>();
  const [source, setSource] = useState<RevisionDiffSource>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<'previous' | 'current'>('previous');
  const [confirm, setConfirm] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const edge = 8;
      const width = Math.min(scaledPx(480), window.innerWidth - edge * 2);
      const beside = rect.right + 6 + width <= window.innerWidth - edge;
      const room = Math.min(scaledPx(240), window.innerHeight - edge * 2);
      const wanted = beside ? Math.max(edge, rect.top) : rect.bottom + 4;
      // Slide up rather than squash when the entry sits near the bottom of the window.
      const top = Math.min(wanted, window.innerHeight - room - edge);
      setStyle({
        left: beside ? rect.right + 6 : Math.max(edge, window.innerWidth - width - edge),
        top,
        width,
        maxHeight: window.innerHeight - top - edge,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);
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

  function restore() {
    if (!source) return;
    try {
      onRestore(source.revision);
      onClose(false);
    } catch (reason) {
      setRestoreError(errorMessage(reason));
    }
  }

  return (
    <div
      id={id}
      role="dialog"
      aria-label={`Revision ${entry.commit.slice(0, 8)}`}
      data-pinned={pinned || undefined}
      className={`${popover.surface} ${styles.revision}`}
      style={style}
    >
      <div className={`${popover.body} ${styles.revisionBody}`}>
        <div className={styles.revisionHead}>
          <strong>
            {mode === 'previous' ? 'Changed in this revision' : 'Compared with current'}
          </strong>
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
        {source &&
          (mode === 'previous' ? (
            <>
              {!source.previous && <p>First revision: everything is new.</p>}
              <TooltipDiff
                before={source.previous}
                current={source.revision}
                item={item}
                raw={false}
              />
            </>
          ) : (
            current && (
              <TooltipDiff before={source.revision} current={current} item={item} raw={false} />
            )
          ))}
        {source && canRestore && (
          <div className={styles.revisionActions}>
            {translator && (
              <p>
                Restore replaces only your assigned translation languages; other fields stay
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
                <p>Replaces the local draft for this tooltip. It does not save or push.</p>
                <button type="button" onClick={restore}>
                  Load as draft
                </button>{' '}
                <button type="button" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
