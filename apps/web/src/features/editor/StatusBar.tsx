import { usePreviewWarnings, type PreviewWarningContext } from '../preview/usePreviewWarnings';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { canReplaceGlyph, type GlyphWarning, type ValidationIssue } from '@clarity/core';
import styles from './StatusBar.module.scss';
import type { CursorPositionStore } from './cursorPosition';
import { keyOf } from './help/reference';

export type StatusPanel = 'help' | 'issues' | 'glyphs' | 'conflicts' | 'retired' | 'diff';

export const CursorStatusBar = memo(function CursorStatusBar({
  cursor,
  ...props
}: Omit<ComponentProps<typeof StatusBar>, 'line' | 'column'> & { cursor: CursorPositionStore }) {
  const position = useSyncExternalStore(cursor.subscribe, cursor.getSnapshot, cursor.getSnapshot);
  return <StatusBar {...props} line={position.line} column={position.column} />;
});

/** Unresolved conflict blocks in the text: the bar counts them and jumps to the next. */
export interface ConflictStatus {
  count: number;
  onNext(): void;
}

/** What the page tells the bar about the preview column: how many edits it has not shown yet. */
export interface PreviewStatus {
  /** Items with edits no Base or Enhanced render has shown. */
  unpreviewed?: number;
  /** Live review status stays local to the bar, so acknowledgements never rerender the workspace. */
  review?: PreviewWarningContext;
  /** The column is hidden, so nothing is being shown. */
  collapsed: boolean;
  /** Opens the column on a render that counts as seen. */
  onShow(): void;
}

export interface GlyphGroup {
  warning: GlyphWarning;
  count: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How far the bar has given up its labels to fit (see `.bar[data-fit]`): 0 as wide as room allows. */
const fitSteps = 5;
/** The step with short labels: a cut read-only reason steps no further (it may always ellipsise). */
const shortLabels = 2;

/**
 * Fits the bar's items on its one line: it takes the first step (tight items, short labels,
 * the retired sign alone, Changes as its glyph, then counts with a mark) at which nothing runs past the edge, so labels shorten only
 * as far as the items need. A read-only reason cut short also steps down, as far as the short
 * labels, to give it room. It measures only when the set of items or the bar's size changes,
 * never on a caret move or a keystroke that changes neither, and it measures after the browser
 * has laid the page out (a resize observer's callback, before that frame paints), so a newly
 * mounted editor is never laid out early, inside the render that mounts it, just for the bar.
 */
function useFit(bar: RefObject<HTMLDivElement | null>, content: string) {
  const fit = useRef<() => void>(() => undefined);
  fit.current = () => {
    const element = bar.current;
    if (!element) return;
    const reason = element.querySelector<HTMLElement>('[data-status-reason]');
    const cut = (item: HTMLElement | null | undefined) =>
      !!item && item.scrollWidth > item.clientWidth + 1;
    // The preview item may shrink only while it is idle and unreserved (nothing to show). Shown
    // or reserved, a squeezed item counts as crowded, and its count text cut short steps down
    // as far as the short labels, as a cut read-only reason does.
    const preview = element.querySelector<HTMLElement>('[data-status-preview]');
    const previewHolds =
      !!preview &&
      (!preview.hasAttribute('data-inactive') || preview.hasAttribute('data-reserved'));
    const previewText = previewHolds
      ? preview.querySelector<HTMLElement>('[data-status-preview-text]')
      : null;
    const crowded = (step: number) =>
      element.scrollWidth > element.clientWidth + 1 ||
      (previewHolds && cut(preview)) ||
      (step < shortLabels && (cut(reason) || cut(previewText)));
    let step = 0;
    element.dataset.fit = '0';
    while (step < fitSteps && crowded(step)) element.dataset.fit = String(++step);
  };
  // Asks the observer to fit again after the next layout; null without an observer.
  const refit = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    if (typeof ResizeObserver === 'undefined') {
      fit.current();
      return;
    }
    let pending = true;
    let width = -1;
    let height = -1;
    const resize = new ResizeObserver(() => {
      // Its own steps never resize the bar; new items, a new width or interface scale do.
      if (!pending && element.clientWidth === width && element.clientHeight === height) return;
      pending = false;
      fit.current();
      width = element.clientWidth;
      height = element.clientHeight;
    });
    resize.observe(element);
    refit.current = () => {
      // Observing the bar afresh reports it after the next layout, even at the same size.
      pending = true;
      resize.unobserve(element);
      resize.observe(element);
    };
    return () => {
      resize.disconnect();
      refit.current = null;
    };
  }, [bar]);
  const measured = useRef(content);
  useLayoutEffect(() => {
    if (measured.current === content) return;
    measured.current = content;
    if (refit.current) refit.current();
    else fit.current();
  }, [content]);
}

/**
 * The line under the editor text: 24px (32px on a phone, where items are 28px targets; 48px Large),
 * one line, and only the flexible texts (read-only reason, key hints) ever ellipsise. It never
 * changes height, and the panels it opens (issues, character warnings, markup help) draw upward
 * over the text instead of resizing the editor, so the text above never moves.
 */
export function StatusBar({
  readOnlyReason,
  issues,
  validating = false,
  glyphCount,
  retiredCount = 0,
  line,
  column,
  preview,
  conflicts,
  changes,
  panel,
  onPanel,
  onSuggest,
  rawView,
  onRawView,
}: {
  readOnlyReason: string | null;
  issues: readonly ValidationIssue[];
  validating?: boolean;
  glyphCount: number;
  /** Retired markup forms in the text (core/validation/retired.ts); each is also a warning. */
  retiredCount?: number;
  line: number;
  column: number;
  preview?: PreviewStatus;
  conflicts?: ConflictStatus;
  /**
   * Whether the text differs from the saved version (the Changes view). Undefined where there
   * is no saved version to compare with: the item is not drawn at all.
   */
  changes?: boolean;
  panel: StatusPanel | null;
  onPanel(panel: StatusPanel | null): void;
  /** Opens the suggestion menu on request (touch has no Ctrl+Space); shown on touch only. */
  onSuggest?(): void;
  /** Whether symbols show as raw markup; undefined when this editor draws no symbols. */
  rawView?: boolean;
  onRawView?(): void;
}) {
  const liveWarnings = usePreviewWarnings(preview?.review);
  const unpreviewed = preview?.review ? liveWarnings : (preview?.unpreviewed ?? 0);
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const toggle = (next: StatusPanel) => onPanel(panel === next ? null : next);
  const root = useRef<HTMLDivElement>(null);
  const showsPreview = preview ? unpreviewed > 0 || preview.collapsed : undefined;
  // The idle preview item gives its room to the labels until it first shows for this text; from
  // then on it keeps that room while idle, so a slow render while typing changes the labels at
  // most once instead of on every render (see .preview[data-reserved]).
  const reserveKey = String(preview?.review?.canonical ?? '');
  const reserve = useRef({ key: reserveKey, on: false });
  if (reserve.current.key !== reserveKey) reserve.current = { key: reserveKey, on: false };
  if (showsPreview) reserve.current.on = true;
  const reserved = reserve.current.on;
  useFit(
    root,
    [
      changes !== undefined,
      readOnlyReason ?? '',
      issues.length,
      retiredCount,
      glyphCount,
      conflicts?.count ?? 0,
      rawView !== undefined && Boolean(onRawView),
      Boolean(onSuggest),
      showsPreview,
      reserved,
    ].join('|'),
  );
  return (
    <div
      ref={root}
      className={styles.bar}
      data-editor-status
      aria-label="Editor status"
      role="group"
      aria-busy={validating || undefined}
      // Esc on a bar item closes the open panel, as it does from the text and inside the panel.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || panel === null) return;
        event.stopPropagation();
        onPanel(null);
      }}
    >
      {changes !== undefined && (
        // First in the bar and always the same width: it is disabled, never removed, while
        // nothing is unsaved, so the first key typed moves nothing.
        <button
          type="button"
          className={styles.item}
          data-status-changes
          disabled={!changes && panel !== 'diff'}
          aria-expanded={panel === 'diff'}
          aria-controls="editor-panel-diff"
          aria-keyshortcuts="Control+K D"
          aria-label="Changes since the last save"
          title={
            changes || panel === 'diff'
              ? 'Show what changed since the last save (Ctrl+K, then D)'
              : 'No changes since the last save'
          }
          // With the caret in the text, pressing it leaves the caret there: typing goes on while
          // the view is open, and Esc in the text closes it. From anywhere else the button takes
          // focus as usual and hands it to the panel.
          onMouseDown={(event) => {
            const text = event.currentTarget
              .closest('[data-editor-root]')
              ?.querySelector('.cm-content');
            if (text?.contains(event.currentTarget.ownerDocument.activeElement))
              event.preventDefault();
          }}
          onClick={() => toggle('diff')}
        >
          <span className={styles.roomy}>Changes</span>
          <span className={styles.tiny} aria-hidden="true">
            ±
          </span>
        </button>
      )}
      {readOnlyReason && (
        <span className={styles.reason} title={readOnlyReason} data-status-reason>
          {readOnlyReason}
        </span>
      )}
      <button
        type="button"
        className={styles.item}
        data-status-help
        aria-expanded={panel === 'help'}
        aria-controls="editor-panel-help"
        aria-keyshortcuts="F1"
        aria-label="Markup help"
        data-mark="?"
        title="Markup help: what you write and what it draws, and the keys (F1)"
        // With the caret in the text, the caret stays there (F1 there opens on its markup).
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => toggle('help')}
      >
        <span className={styles.long}>Markup help</span>
        <span className={styles.short}>Help</span>
      </button>
      {issues.length > 0 && (
        <button
          type="button"
          className={styles.item}
          data-severity={errors > 0 ? 'error' : 'warning'}
          data-status-issues
          aria-expanded={panel === 'issues'}
          aria-controls="editor-panel-issues"
          title="Markup issues in this text"
          aria-label={validating ? 'Checking markup' : plural(issues.length, 'markup issue')}
          data-mark="⊗"
          onClick={() => toggle('issues')}
        >
          <span>
            {issues.length}
            <span className={styles.word}> {issues.length === 1 ? 'issue' : 'issues'}</span>
          </span>
        </button>
      )}
      {rawView !== undefined && onRawView && (
        <button
          type="button"
          className={styles.item}
          title="Show the raw markup instead of symbols and colours (Ctrl+Shift+.)"
          aria-pressed={rawView}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRawView}
        >
          Raw
        </button>
      )}
      {/* A live region so a warning that appears while typing is announced without moving focus. */}
      <span role="status" aria-live="polite" className={styles.live}>
        {retiredCount > 0 && (
          <button
            type="button"
            className={styles.item}
            data-severity="warning"
            data-status-retired
            aria-expanded={panel === 'retired'}
            aria-controls="editor-panel-retired"
            title="Retired markup: still renders, no longer supported. Click to see the fixes."
            aria-label={`${retiredCount} retired markup`}
            onClick={() => toggle('retired')}
          >
            <span>
              <span aria-hidden="true">⚠</span> {retiredCount}{' '}
              <span className={styles.long}>retired markup</span>
              <span className={`${styles.short} ${styles.roomy}`}>retired</span>
            </span>
          </button>
        )}
        {glyphCount > 0 && (
          <button
            type="button"
            className={styles.item}
            data-severity="warning"
            aria-expanded={panel === 'glyphs'}
            aria-controls="editor-panel-glyphs"
            title="Characters that may not display in the game; saving is allowed"
            aria-label={plural(glyphCount, 'character warning')}
            data-mark="▯"
            onClick={() => toggle('glyphs')}
          >
            <span>
              {glyphCount}
              <span className={styles.word}> </span>
              <span className={styles.long}>character warning{glyphCount === 1 ? '' : 's'}</span>
              <span className={styles.short}>glyph{glyphCount === 1 ? '' : 's'}</span>
            </span>
          </button>
        )}
      </span>
      {conflicts && conflicts.count > 0 && (
        <button
          type="button"
          className={styles.item}
          data-severity="warning"
          data-status-conflicts
          title="Unresolved conflicts. F8 jumps to the next, Shift+F8 to the previous."
          aria-label={`${plural(conflicts.count, 'unresolved conflict')}. Jump to the next`}
          data-mark="⇄"
          onClick={conflicts.onNext}
        >
          <span>
            {conflicts.count}
            <span className={styles.word}> conflict{conflicts.count === 1 ? '' : 's'}</span>
          </span>
        </button>
      )}
      {onSuggest && (
        <button
          type="button"
          className={`${styles.item} ${styles.suggest}`}
          title="List every markup option, with the ones that fit here first"
          // Pressing it must not take focus from the text: a selection is what it transforms.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSuggest}
        >
          Suggest
        </button>
      )}
      {/* Whole hints only: one that does not fit wraps out of the one-line box instead of cutting. */}
      <span className={styles.hints} aria-hidden="true">
        {rawView !== undefined && (
          <span data-raw-hint>{rawView ? 'Symbols' : `${keyOf('key-raw')} markup`}</span>
        )}
        <span>{keyOf('key-suggest')} all markup</span>
        <span>{keyOf('key-find')} find</span>
        <span>{keyOf('key-definition')} go to definition</span>
        <span>{keyOf('key-leave')} leaves the editor</span>
        {conflicts && conflicts.count > 0 && <span>{keyOf('key-conflict')} next conflict</span>}
      </span>
      {/* An idle preview item stays in place (hidden) but yields its width to the labels until it
        first shows; once reserved it keeps its room, so it never pushes items while typing. With
        the text read-only nothing is typed, so the read-only reason gets that room instead. */}
      {preview && (showsPreview || !readOnlyReason) && (
        <span
          className={styles.preview}
          data-status-preview
          data-inactive={!(unpreviewed > 0 || preview.collapsed) || undefined}
          data-reserved={reserved || undefined}
          aria-hidden={!(unpreviewed > 0 || preview.collapsed) || undefined}
          data-attention={unpreviewed > 0 || undefined}
        >
          <span
            className={styles.previewText}
            data-status-preview-text
            title={unpreviewed > 0 ? `${plural(unpreviewed, 'change')} not previewed` : undefined}
          >
            {unpreviewed > 0 ? `${unpreviewed} not previewed` : 'Preview hidden'}
          </span>
          <button
            type="button"
            className={styles.item}
            onClick={preview.onShow}
            disabled={!(unpreviewed > 0 || preview.collapsed)}
          >
            Show preview
            <kbd>Alt+P</kbd>
          </button>
        </span>
      )}
      <span className={styles.position} aria-label={`Line ${line}, column ${column}`}>
        Ln {line}, Col {column}
      </span>
    </div>
  );
}

/** An overlay that opens upward over the text, directly above the status bar. */
export function Overlay({
  id,
  label,
  heading,
  onClose,
  children,
}: {
  id: string;
  label: string;
  /**
   * A caption for a panel whose content scrolls: it and Close stay in a fixed row on top and
   * only the content below scrolls. Without it the whole panel scrolls as one (short panels).
   */
  heading?: ReactNode;
  onClose(): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  // Where focus was when the panel opened (the text, or the bar item that opened it): closing
  // puts it back there, never somewhere new (a phone must not get its keyboard from a Close).
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(() => undefined as void);
  close.current = () => {
    onClose();
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    // Esc closes it from inside; the editor's own Esc handling covers the caret being in the text.
    const element = root.current;
    if (!element) return;
    // Opened from a status bar button: focus would stay on that button, outside the panel, so Esc
    // would do nothing and Tab would skip the panel. Move it into the panel (a click or Enter on
    // the item, never the caret in the text, which keeps focus).
    const active = element.ownerDocument.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== element.ownerDocument.body ? active : null;
    if (active?.closest('[data-editor-status]')) element.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, []);
  const headed = heading !== undefined;
  useEffect(() => {
    // A phone's keyboard shrinks the visual viewport, not the page: a captioned panel sizes
    // itself to what is really visible (see .overlay[data-headed]). Only while it is open.
    const element = root.current;
    const viewport = element?.ownerDocument.defaultView?.visualViewport;
    if (!headed || !element || !viewport) return;
    const fit = () => element.style.setProperty('--visible-h', `${Math.round(viewport.height)}px`);
    fit();
    viewport.addEventListener('resize', fit);
    return () => viewport.removeEventListener('resize', fit);
  }, [headed]);
  const closeButton = (
    <button
      type="button"
      className={styles.close}
      aria-label={`Close ${label}`}
      onClick={() => close.current()}
    >
      ×
    </button>
  );
  return (
    <section
      ref={root}
      id={id}
      aria-label={label}
      tabIndex={-1}
      className={styles.overlay}
      data-editor-overlay
      data-headed={headed || undefined}
    >
      {headed ? (
        <>
          <div className={styles.overlayHead}>
            <span className={styles.overlayTitle}>{heading}</span>
            {closeButton}
          </div>
          <div className={styles.overlayBody} data-overlay-scroll>
            {children}
          </div>
        </>
      ) : (
        <>
          <div className={styles.overlayBody}>{children}</div>
          {closeButton}
        </>
      )}
    </section>
  );
}

export function GlyphPanel({
  groups,
  value,
  readOnly,
  onReplace,
  onClose,
}: {
  groups: readonly GlyphGroup[];
  value: string;
  readOnly: boolean;
  onReplace(character: string, replacement: string): void;
  onClose(): void;
}) {
  return (
    <Overlay id="editor-panel-glyphs" label="Character display warnings" onClose={onClose}>
      <p className={styles.lead}>
        These characters may not display in the game. Saving is allowed.
      </p>
      <ul aria-label="Character display warnings">
        {groups.slice(0, 6).map(({ warning, count }) => (
          <li key={warning.character}>
            {warning.message} {count > 1 && `(${count} occurrences)`}{' '}
            {!readOnly && canReplaceGlyph(value, warning) && (
              <button
                type="button"
                onClick={() => onReplace(warning.character, warning.replacement!)}
              >
                Replace first {warning.codePoint} with {warning.replacement}
              </button>
            )}
          </li>
        ))}
      </ul>
      {groups.length > 6 && (
        <p>{groups.length - 6} more character types highlighted in the editor.</p>
      )}
    </Overlay>
  );
}

/** The markup issues in the text; it closes itself once there are none. */
export function IssuesPanel({
  issues,
  onClose,
}: {
  issues: readonly ValidationIssue[];
  onClose(): void;
}) {
  return (
    <Overlay id="editor-panel-issues" label="Markup issues" onClose={onClose}>
      <ul aria-label="Markup issues">
        {issues.slice(0, 50).map((issue, index) => (
          <li key={index} data-severity={issue.severity}>
            {issue.severity}: {issue.message}
          </li>
        ))}
        {issues.length > 50 && <li>{issues.length - 50} more issues highlighted in the editor.</li>}
      </ul>
    </Overlay>
  );
}

/**
 * Phone / touch version of the conflict actions: the in-text widget is one chip, and this panel
 * (touch-size targets) opens upward over the text with the same choices.
 */
export function ConflictPanel({
  index,
  count,
  readOnly,
  onResolve,
  onCompare,
  onStep,
  onClose,
}: {
  index: number;
  count: number;
  readOnly: boolean;
  onResolve(choice: 'mine' | 'theirs' | 'both'): void;
  onCompare(): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}) {
  return (
    <Overlay id="editor-panel-conflicts" label="Resolve conflict" onClose={onClose}>
      <p className={styles.lead}>
        Conflict {index + 1} of {count}: your lines and theirs differ.
      </p>
      <div className={styles.conflictActions}>
        {!readOnly && (
          <>
            <button type="button" onClick={() => onResolve('mine')}>
              Accept mine
            </button>
            <button type="button" onClick={() => onResolve('theirs')}>
              Accept theirs
            </button>
            <button type="button" onClick={() => onResolve('both')}>
              Accept both
            </button>
          </>
        )}
        <button type="button" onClick={onCompare}>
          Compare
        </button>
        {count > 1 && (
          <>
            <button type="button" onClick={() => onStep(-1)}>
              Previous
            </button>
            <button type="button" onClick={() => onStep(1)}>
              Next
            </button>
          </>
        )}
      </div>
    </Overlay>
  );
}
