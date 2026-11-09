import {
  memo,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { canReplaceGlyph, type GlyphWarning, type ValidationIssue } from '@clarity/core';
import styles from './StatusBar.module.scss';
import type { CursorPositionStore } from './cursorPosition';

export type StatusPanel = 'help' | 'glyphs' | 'conflicts';

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
  unpreviewed: number;
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

/**
 * The line under the editor text: 24px (52px on a phone, where every control is a 44px target),
 * one line, and only the flexible texts (read-only reason, key hints) ever ellipsise. It never
 * changes height, and the two panels it opens (character warnings, markup help) draw upward over
 * the text instead of resizing the editor, so the text above never moves.
 */
export function StatusBar({
  readOnlyReason,
  issues,
  validating = false,
  glyphCount,
  line,
  column,
  preview,
  conflicts,
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
  line: number;
  column: number;
  preview?: PreviewStatus;
  conflicts?: ConflictStatus;
  panel: StatusPanel | null;
  onPanel(panel: StatusPanel | null): void;
  /** Opens the suggestion menu on request (touch has no Ctrl+Space); shown on touch only. */
  onSuggest?(): void;
  /** Whether symbols show as raw markup; undefined when this editor draws no symbols. */
  rawView?: boolean;
  onRawView?(): void;
}) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const toggle = (next: StatusPanel) => onPanel(panel === next ? null : next);
  return (
    <div
      className={styles.bar}
      data-editor-status
      aria-label="Editor status"
      role="group"
      aria-busy={validating || undefined}
    >
      {readOnlyReason && (
        <span className={styles.reason} title={readOnlyReason} data-status-reason>
          {readOnlyReason}
        </span>
      )}
      <button
        type="button"
        className={styles.item}
        data-severity={errors > 0 ? 'error' : issues.length > 0 ? 'warning' : undefined}
        aria-expanded={panel === 'help'}
        aria-controls="editor-panel-help"
        title="Markup issues and editor help"
        aria-label={
          validating
            ? 'Checking markup'
            : issues.length
              ? plural(issues.length, 'markup issue')
              : 'Markup help'
        }
        onClick={() => toggle('help')}
      >
        {issues.length ? (
          <span>
            {issues.length} <span className={styles.long}>markup </span>
            {issues.length === 1 ? 'issue' : 'issues'}
          </span>
        ) : (
          <span>
            <span className={styles.long}>Markup help</span>
            <span className={styles.short}>Help</span>
          </span>
        )}
      </button>
      {rawView !== undefined && onRawView && (
        <button
          type="button"
          className={`${styles.item} ${styles.suggest}`}
          title="Ctrl+Shift+. toggles raw markup"
          aria-pressed={rawView}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRawView}
        >
          {rawView ? 'Symbols' : 'Markup'}
        </button>
      )}
      {/* A live region so a warning that appears while typing is announced without moving focus. */}
      <span role="status" aria-live="polite" className={styles.live}>
        {glyphCount > 0 && (
          <button
            type="button"
            className={styles.item}
            data-severity="warning"
            aria-expanded={panel === 'glyphs'}
            aria-controls="editor-panel-glyphs"
            title="Characters that may not display in the game; saving is allowed"
            aria-label={plural(glyphCount, 'character warning')}
            onClick={() => toggle('glyphs')}
          >
            <span>
              {glyphCount}{' '}
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
          onClick={conflicts.onNext}
        >
          {plural(conflicts.count, 'conflict')}
        </button>
      )}
      {onSuggest && (
        <button
          type="button"
          className={`${styles.item} ${styles.suggest}`}
          title="Suggest markup, snippets and transforms"
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
          <span data-raw-hint>{rawView ? 'Symbols' : 'Ctrl+Shift+. markup'}</span>
        )}
        <span>Ctrl+Space suggestions</span>
        <span>Ctrl+F find</span>
        <span>F12 go to definition</span>
        <span>Esc then Tab leaves the editor</span>
        {conflicts && conflicts.count > 0 && <span>F8 next conflict</span>}
      </span>
      {preview && (preview.unpreviewed > 0 || preview.collapsed) && (
        <span className={styles.preview} data-attention={preview.unpreviewed > 0 || undefined}>
          <span
            className={styles.previewText}
            title={
              preview.unpreviewed > 0
                ? `${plural(preview.unpreviewed, 'change')} not previewed`
                : undefined
            }
          >
            {preview.unpreviewed > 0 ? `${preview.unpreviewed} not previewed` : 'Preview hidden'}
          </span>
          <button type="button" className={styles.item} onClick={preview.onShow}>
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
  onClose,
  children,
}: {
  id: string;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Esc closes it from inside; the editor's own Esc handling covers the caret being in the text.
    const element = root.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, []);
  return (
    <section ref={root} id={id} aria-label={label} className={styles.overlay} data-editor-overlay>
      <div className={styles.overlayBody}>{children}</div>
      <button
        type="button"
        className={styles.close}
        aria-label={`Close ${label}`}
        onClick={onClose}
      >
        ×
      </button>
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

export function HelpPanel({
  issues,
  onClose,
}: {
  issues: readonly ValidationIssue[];
  onClose(): void;
}) {
  return (
    <Overlay id="editor-panel-help" label="Markup help" onClose={onClose}>
      {issues.length > 0 && (
        <ul aria-label="Markup issues">
          {issues.slice(0, 50).map((issue, index) => (
            <li key={index} data-severity={issue.severity}>
              {issue.severity}: {issue.message}
            </li>
          ))}
          {issues.length > 50 && (
            <li>{issues.length - 50} more issues highlighted in the editor.</li>
          )}
        </ul>
      )}
      <p>
        Ctrl/Cmd+F: find and replace. Ctrl/Cmd+Space: complete. Ctrl/Cmd+Z: undo. Ctrl/Cmd+/:
        comment. Scroll Lock or Ctrl/Cmd+Shift+F: align tables. Tab indents; to leave the editor
        with the keyboard, press Esc, then Tab.
      </p>
      <p>
        Hover a #variable, [title] or import to see what it contains (Ctrl/Cmd+K, Ctrl/Cmd+I does
        the same from the caret). Ctrl/Cmd+Click or F12 jumps to its definition; the browser Back
        button returns.
      </p>
      <p>
        Alt+Enter on coloured text (like Alt+click) opens its tag: Enter edits the colour, Backspace
        removes the tag and keeps the text. Ctrl/Cmd+Shift+. or the Raw button in the markup row
        shows the markup as stored.
      </p>
      <p>
        Native spelling uses your browser&apos;s enabled dictionaries. Right-click a misspelling for
        suggestions.
      </p>
    </Overlay>
  );
}

/**
 * Phone / touch version of the conflict actions: the in-text widget is one chip, and this panel
 * (44px targets) opens upward over the text with the same choices.
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
