import { useEffect, useRef, type ReactNode } from 'react';
import { canReplaceGlyph, type GlyphWarning, type ValidationIssue } from '@clarity/core';
import styles from './StatusBar.module.scss';

export type StatusPanel = 'help' | 'glyphs';

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
  glyphCount,
  line,
  column,
  preview,
  panel,
  onPanel,
}: {
  readOnlyReason: string | null;
  issues: readonly ValidationIssue[];
  glyphCount: number;
  line: number;
  column: number;
  preview?: PreviewStatus;
  panel: StatusPanel | null;
  onPanel(panel: StatusPanel | null): void;
}) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const toggle = (next: StatusPanel) => onPanel(panel === next ? null : next);
  return (
    <div className={styles.bar} data-editor-status aria-label="Editor status" role="group">
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
        aria-label={issues.length ? plural(issues.length, 'markup issue') : 'Markup help'}
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
      <span className={styles.hints}>
        Ctrl+Space complete · Ctrl+F find · F12 go to definition · Esc then Tab leaves the editor
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
function Overlay({
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
        Native spelling uses your browser&apos;s enabled dictionaries. Right-click a misspelling for
        suggestions.
      </p>
    </Overlay>
  );
}
