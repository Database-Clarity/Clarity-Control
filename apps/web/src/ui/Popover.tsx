import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
  open: controlledOpen,
  onOpenChange,
  anchorElement,
}: {
  /** Names both the trigger's popup and the surface. */
  label: string;
  /** The trigger button's content. */
  trigger?: ReactNode;
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
  /** Optional external control; an anchor keeps focus in an existing input. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorElement?: HTMLElement;
}) {
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const external = useRef({ controlledOpen, onOpenChange, anchorElement });
  external.current = { controlledOpen, onOpenChange, anchorElement };
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const id = useId();
  useWorkspaceShortcutOwner(surface, open && contain);
  const close = useCallback((restoreFocus: boolean) => {
    if (external.current.controlledOpen === undefined) setOpen(false);
    external.current.onOpenChange?.(false);
    if (restoreFocus) {
      const anchor = external.current.anchorElement;
      (anchor?.querySelector<HTMLElement>('input') ?? anchor ?? button.current)?.focus();
    }
  }, []);
  const clearTopRef = useRef(clearTop);
  clearTopRef.current = clearTop;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const element = surface.current;
      const anchor = anchorElement ?? button.current;
      if (!element || !anchor) return;
      const phone = isPhone();
      const area = visibleArea(window, phone ? clearTopRef.current?.() : undefined);
      const input = {
        trigger: anchor.getBoundingClientRect(),
        area,
        width: phone ? Infinity : 560,
        gap,
      };
      // Below first, at the final width, so the content's height is measured as it will wrap.
      const below = placeAnchored(input);
      applyPlacement(element, below);
      const height = naturalHeight(element, element.firstElementChild as HTMLElement | null);
      if (height > below.maxHeight) applyPlacement(element, placeAnchored({ ...input, height }));
    };
    place();
    return followPlacement(() => surface.current, place);
  }, [open, gap, anchorElement]);
  useEffect(() => {
    if (!open || contain || anchorElement) return;
    // Preserve the trigger's place in sequential keyboard navigation across the portal.
    const items = () => [
      ...(surface.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ) ?? []),
    ];
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = items();
      const active = document.activeElement;
      if (!event.shiftKey && active === button.current && list.length) {
        event.preventDefault();
        list[0].focus();
      } else if (event.shiftKey && active === list[0]) {
        event.preventDefault();
        button.current?.focus();
      } else if (!event.shiftKey && active === list.at(-1)) {
        // Let the browser continue after the trigger in the original document order.
        button.current?.focus();
      } else if (event.shiftKey && list.length && !surface.current?.contains(active)) {
        // The surface's portal is at the end of body. Re-enter it when navigating
        // backwards from the control that originally followed the trigger.
        const order = [
          ...document.querySelectorAll<HTMLElement>(
            'button, a[href], select, input, textarea, [tabindex]',
          ),
        ].filter(
          (item) =>
            item.tabIndex >= 0 &&
            !item.matches(':disabled') &&
            !item.closest('[inert]') &&
            !surface.current?.contains(item) &&
            item.getClientRects().length > 0,
        );
        const index = order.indexOf(button.current!);
        if (index >= 0 && active === order[index + 1]) {
          event.preventDefault();
          list.at(-1)?.focus();
        }
      }
    };
    document.addEventListener('keydown', tab, true);
    return () => document.removeEventListener('keydown', tab, true);
  }, [open, contain, anchorElement]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        surface.current?.contains(target) ||
        button.current?.contains(target) ||
        external.current.anchorElement?.contains(target)
      )
        return;
      close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    const back = () => close(true);
    window.addEventListener('popstate', back);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('popstate', back);
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
      {!anchorElement && (
        <button
          ref={button}
          type="button"
          className={className}
          title={triggerTitle}
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            if (controlledOpen === undefined) setOpen((value) => !value);
            onOpenChange?.(!open);
          }}
        >
          {trigger}
        </button>
      )}
      {open &&
        createPortal(
          <div ref={surface} id={id} role="dialog" aria-label={label} className={styles.surface}>
            <div className={flush ? `${styles.body} ${styles.flush}` : styles.body}>
              {typeof children === 'function'
                ? children((restore = true) => close(restore))
                : children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
