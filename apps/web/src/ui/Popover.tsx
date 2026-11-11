import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  applyPlacement,
  followPlacement,
  isPhone,
  naturalHeight,
  placeAnchored,
  visibleArea,
} from './anchorPlacement';
import { useWorkspaceShortcutOwner } from './interaction';
import styles from './Popover.module.scss';

/**
 * A small non-modal surface anchored to its trigger on every screen size: it floats under the
 * button (right-aligned), or above it when the content fits better there, inside the visible area
 * (on a phone: the page width less the edge inset, clear of the keyboard and the docked bar; see
 * anchorPlacement.ts). Esc or a press outside closes it and returns focus to the trigger. It is
 * positioned `fixed`, so no pane header or scroller clips it, and it takes no space in the flow
 * (opening it moves nothing). It follows its trigger while the page scrolls or the keyboard moves.
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
  gap = 4,
  clearTop,
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
  /** Space between the trigger and the surface (0: flush on a bar). */
  gap?: number;
  /**
   * Phones: the lowest y the surface may reach up to (the sticky header's lower edge), read on each
   * placement; the surface then never covers that chrome.
   */
  clearTop?: () => number;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const id = useId();
  useWorkspaceShortcutOwner(surface, open && contain);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  const clearTopRef = useRef(clearTop);
  clearTopRef.current = clearTop;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const element = surface.current;
      if (!element || !button.current) return;
      const phone = isPhone();
      const area = visibleArea(window, phone ? clearTopRef.current?.() : undefined);
      const input = {
        trigger: button.current.getBoundingClientRect(),
        area,
        width: phone ? Infinity : 560,
        gap,
        desktop: !phone,
      };
      // Below first, at the final width, so the content's height is measured as it will wrap.
      const below = placeAnchored(input);
      applyPlacement(element, below);
      if (!phone) return;
      const height = naturalHeight(element, element.firstElementChild as HTMLElement | null);
      if (height > below.maxHeight) applyPlacement(element, placeAnchored({ ...input, height }));
    };
    place();
    return followPlacement(() => surface.current, place);
  }, [open, gap]);
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
    // The content can name its own first focus (a confirm's safe Cancel) with data-autofocus.
    (
      items.find((item) => item.hasAttribute('data-autofocus')) ??
      items.find((item) => !item.getAttribute('aria-label')?.startsWith('Close')) ??
      items[0]
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
        <div ref={surface} id={id} role="dialog" aria-label={label} className={styles.surface}>
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
