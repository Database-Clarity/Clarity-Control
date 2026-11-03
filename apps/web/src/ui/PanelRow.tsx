import { useId, useState, type ReactNode } from 'react';
import styles from './PanelRow.module.scss';

/**
 * A one-line (28px) row that expands in place: label and summary on the left, optional actions on
 * the right. Used for the rows pinned under the preview (associations, history, notes). The body
 * is mounted only while open; the row itself never wraps (flexible text ellipsises).
 */
export function PanelRow({
  label,
  summary,
  actions,
  children,
  open: controlled,
  onOpenChange,
  className,
}: {
  label: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  className?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const body = useId();
  const toggle = () => {
    onOpenChange?.(!open);
    if (controlled === undefined) setOwn(!open);
  };
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <div className={`${styles.row} ${className ?? ''}`} data-open={open || undefined}>
      <div className={styles.head}>
        {expandable ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={open ? body : undefined}
            onClick={toggle}
          >
            <span className={styles.chevron} aria-hidden="true" />
            <span className={styles.label}>{label}</span>
          </button>
        ) : (
          <span className={styles.toggle}>
            <span className={styles.label}>{label}</span>
          </span>
        )}
        {summary !== undefined && <span className={styles.summary}>{summary}</span>}
        {actions && <span className={styles.actions}>{actions}</span>}
      </div>
      {open && expandable && (
        <div id={body} className={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
}
