import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Dialog.module.scss';

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  /** Primary actions; sticks to the bottom of the sheet at the mobile breakpoint. */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className={styles.header}>
        <h2>{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog">
          Close
        </button>
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </dialog>
  );
}
