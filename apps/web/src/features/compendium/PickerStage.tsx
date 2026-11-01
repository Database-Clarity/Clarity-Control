import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './PickerStage.module.scss';

/** A dedicated stage: native modality owns focus and pointer interaction. */
export function PickerStage({
  children,
  onBack,
  open,
}: {
  children: ReactNode;
  onBack(): void;
  open: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const ref = useRef<HTMLDialogElement>(null);
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    if (!open || !mounted) return;
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    // Keep the first search/control immediately available, with Back before it.
    dialog.querySelector<HTMLElement>('input,select')?.focus();
    const stop = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
          ),
        ].filter((node) => node.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        back.current();
      } else if (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 's') {
        // Do not prevent text entry; suspend page-level decision shortcuts.
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', stop, true);
    return () => {
      window.removeEventListener('keydown', stop, true);
      dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, mounted]);
  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={ref}
      className={styles.stage}
      aria-label="Choose Compendium source"
      onCancel={(event) => {
        event.preventDefault();
        onBack();
      }}
    >
      <header>
        <button type="button" onClick={onBack}>
          Back
        </button>
        <h2>Choose source</h2>
      </header>
      <div className={styles.content}>{children}</div>
    </dialog>,
    document.body,
  );
}
