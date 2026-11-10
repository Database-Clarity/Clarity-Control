import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover } from '../../ui/Popover';
import type { GroupedPerk } from './grouping';
import type { OverrideTarget } from './EditorPaneHeader';
import styles from './EditorMore.module.scss';

/**
 * Phones: the editor's rarely used tools in one bottom sheet, in place of the inline buttons the
 * desktop tool row keeps. Every row calls the same handler as the button it replaces. Rendered
 * only when it has at least one row.
 */
export function EditorMore({
  markup,
  draft,
  saving,
  onDiscard,
  grouped,
  overrides,
  onEditOverride,
  queueBack,
  renderGrouped,
}: {
  /** The markup row toggle; undefined where the text is read-only. */
  markup?: { open: boolean; toggle(): void };
  draft: boolean;
  saving: boolean;
  onDiscard(): void;
  grouped?: GroupedPerk[];
  /** The enhanced overrides to open (empty while one is open: its way back stays in the row). */
  overrides: OverrideTarget[];
  onEditOverride(hash: number): void;
  /** Queue mode: the way back to the Translations queue and what it shows. */
  queueBack?: { to: string; label: string };
  renderGrouped(perks: GroupedPerk[]): React.ReactNode;
}) {
  const [groupedOpen, setGroupedOpen] = useState(false);
  if (!markup && !draft && !grouped && !overrides.length && !queueBack) return null;
  return (
    <Popover
      label="Editor tools"
      className={styles.trigger}
      flush
      contain
      triggerLabel="More editor tools"
      triggerTitle="More editor tools"
      trigger={<span className={styles.dots} aria-hidden="true" />}
    >
      {(close) => (
        <div className={styles.sheet}>
          <header className={styles.head}>
            <strong>Editor tools</strong>
            <button
              type="button"
              className={styles.close}
              aria-label="Close Editor tools"
              onClick={() => close()}
            >
              ×
            </button>
          </header>
          <ul className={styles.rows}>
            {markup && (
              <li>
                <button
                  type="button"
                  aria-pressed={markup.open}
                  aria-keyshortcuts="Control+."
                  onClick={markup.toggle}
                >
                  <span>Markup bar</span>
                  <small>{markup.open ? 'On' : 'Off'}</small>
                </button>
              </li>
            )}
            {draft && (
              <DiscardRow
                saving={saving}
                onDiscard={() => {
                  onDiscard();
                  close();
                }}
              />
            )}
            {grouped && (
              <li>
                <button
                  type="button"
                  aria-expanded={groupedOpen}
                  title="Which manifest perks open this editor entry, and how each joined (maintainers)"
                  onClick={() => setGroupedOpen((value) => !value)}
                >
                  <span>Grouped manifest perks</span>
                  <small>
                    {grouped.length} <span aria-hidden="true">{groupedOpen ? '▾' : '›'}</span>
                  </small>
                </button>
                {groupedOpen && <div className={styles.nested}>{renderGrouped(grouped)}</div>}
              </li>
            )}
            {overrides.map((target) => (
              <li key={target.hash}>
                <button
                  type="button"
                  onClick={() => {
                    onEditOverride(target.hash);
                    close();
                  }}
                >
                  Edit override{overrides.length > 1 ? `: ${target.name}` : ''}
                </button>
              </li>
            ))}
            {queueBack && (
              <li>
                <Link to={queueBack.to} onClick={() => close(false)}>
                  <span>Back to queue</span>
                  <small>{queueBack.label}</small>
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}
    </Popover>
  );
}

/**
 * Discard asks first, in place (the Drafts list confirms in a dialog): the row becomes the question
 * with Discard and Cancel, focus on Cancel. It lives inside the sheet, so it resets when the sheet
 * closes.
 */
function DiscardRow({ saving, onDiscard }: { saving: boolean; onDiscard(): void }) {
  const [asking, setAsking] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const ask = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (asking) cancel.current?.focus();
    else if (was.current) ask.current?.focus();
    was.current = asking;
  }, [asking]);
  if (!asking)
    return (
      <li>
        <button
          ref={ask}
          type="button"
          data-danger
          disabled={saving}
          aria-label="Discard this tooltip's draft"
          onClick={() => setAsking(true)}
        >
          Discard draft
        </button>
      </li>
    );
  return (
    <li className={styles.confirm} role="group" aria-label="Discard this tooltip's draft?">
      <span>Discard this draft? Its unsaved changes are lost.</span>
      <span className={styles.confirmActions}>
        <button type="button" data-danger disabled={saving} onClick={onDiscard}>
          Discard
        </button>
        <button ref={cancel} type="button" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    </li>
  );
}
