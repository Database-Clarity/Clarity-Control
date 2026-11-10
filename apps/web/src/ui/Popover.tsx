import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useWorkspaceShortcutOwner } from './interaction';
import styles from './Popover.module.scss';

/**
 * A small non-modal surface anchored to its trigger: it floats under the button (right-aligned,
 * kept inside the viewport) and becomes a bottom sheet on a phone. Esc or a press outside closes
 * it and returns focus to the trigger. It is positioned `fixed`, so no pane header or scroller
 * clips it, and it takes no space in the flow (opening it moves nothing).
 */
export function Popover({
  label,
  trigger,
  children,
  className,
  triggerTitle,
  triggerLabel,
  flush = false,
  contain = false,
}: {
  /** Names both the trigger's popup and the surface. */
  label: string;
  /** The trigger button's content. */
  trigger: ReactNode;
  /** Content, or a function of `close` when the content needs to close the surface itself. */
  children: ReactNode | ((close: (restoreFocus?: boolean) => void) => ReactNode);
  className?: string;
  triggerTitle?: string;
  /** The trigger's accessible name, for an icon-only trigger. */
  triggerLabel?: string;
  /** The content runs edge to edge (a menu of rows with its own header): no body padding. */
  flush?: boolean;
  /**
   * A sheet of actions (More): opening moves focus to its first row (after a Close button), Tab
   * cycles inside it, and it owns the workspace shortcuts while open (Alt+PageDown does not step the
   * page behind it), like the shell's sheets.
   */
  contain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>();
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const id = useId();
  useWorkspaceShortcutOwner(surface, open && contain);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const edge = 8;
    const width = Math.min(560, window.innerWidth - edge * 2);
    const left = Math.min(Math.max(edge, rect.right - width), window.innerWidth - width - edge);
    setStyle({
      left,
      top: rect.bottom + 4,
      width,
      maxHeight: Math.max(160, window.innerHeight - rect.bottom - 4 - edge),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (surface.current?.contains(target) || button.current?.contains(target)) return;
      close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, close]);
  useEffect(() => {
    if (!open || !contain) return;
    const focusable = () => [
      ...(surface.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled)',
      ) ?? []),
    ];
    const items = focusable();
    (
      items.find((item) => !item.getAttribute('aria-label')?.startsWith('Close')) ?? items[0]
    )?.focus();
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = focusable();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', tab, true);
    return () => document.removeEventListener('keydown', tab, true);
  }, [open, contain]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        title={triggerTitle}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={surface}
          id={id}
          role="dialog"
          aria-label={label}
          className={styles.surface}
          style={style}
        >
          <div className={flush ? `${styles.body} ${styles.flush}` : styles.body}>
            {typeof children === 'function'
              ? children((restore = true) => close(restore))
              : children}
          </div>
        </div>
      )}
    </>
  );
}
