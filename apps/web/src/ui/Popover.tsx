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
}: {
  /** Names both the trigger's popup and the surface. */
  label: string;
  /** The trigger button's content. */
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  triggerTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>();
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const id = useId();
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
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        title={triggerTitle}
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
          <div className={styles.body}>{children}</div>
        </div>
      )}
    </>
  );
}
