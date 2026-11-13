import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Dialog.module.scss';
import { useNativeDialogShortcutOwner } from './interaction';

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  footer,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  /** Primary actions; sticks to the bottom of the sheet at the mobile breakpoint. */
  footer?: ReactNode;
  /** A short prompt: narrow, and Escape or its own buttons are the only ways out. */
  compact?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useNativeDialogShortcutOwner(ref);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // The opener may have been disabled while the dialog was open, which stops the browser
      // restoring focus; put it back so keyboard users keep their place.
      if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body)
        opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={compact ? `${styles.dialog} ${styles.compact}` : styles.dialog}
      aria-label={title}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className={styles.header}>
        <h2>{title}</h2>
        {!compact && (
          // A phone sheet shows the square × on its right edge, as the Settings sheet does.
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
          >
            <span className={styles.closeText}>Close</span>
            <span className={styles.closeMark} aria-hidden="true">
              ×
            </span>
          </button>
        )}
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </dialog>
  );
}
