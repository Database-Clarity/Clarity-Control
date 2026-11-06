import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { scaledPx } from '../../ui/scale';
import { create } from 'zustand';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './ShellOverlay.module.scss';
import { useWorkspaceShortcutOwner } from '../../ui/interaction';

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Only one shell overlay is open at a time: opening another closes the one before it. */
const useActiveOverlay = create<{ active: symbol | null }>(() => ({ active: null }));

const margin = 8;
const gap = 4;

function place(anchor: Element | null, width: number, align: 'start' | 'end'): CSSProperties {
  if (!anchor) return { top: 40, left: margin, width };
  const rect = anchor.getBoundingClientRect();
  const fit = Math.min(scaledPx(width), window.innerWidth - margin * 2);
  const left =
    align === 'end'
      ? Math.max(margin, Math.min(rect.right - fit, window.innerWidth - fit - margin))
      : Math.max(margin, Math.min(rect.left, window.innerWidth - fit - margin));
  return {
    top: rect.bottom + gap,
    left,
    width: fit,
    maxHeight: Math.max(160, window.innerHeight - rect.bottom - gap - margin),
  };
}

/**
 * Header popovers and phone sheets share one primitive. Desktop: a popover anchored under its
 * header button. Phone (<= 700px): a bottom sheet. Opening moves focus in; Tab stays inside;
 * Escape or an outside click closes it and focus returns to the stable header button (never the
 * menu item that opened something else). A modal overlay also makes the rest of the page inert
 * and stops body scrolling.
 *
 * It marks itself `data-shell-overlay`, so Shift+wheel stepping and the workspace shortcuts stand
 * down while it is open, and a native save/conflict dialog (`dialog[open]`) keeps Escape and Tab.
 * With `keepMounted`, children stay mounted (hidden) while closed, for content that owns
 * listeners, such as the finder.
 */
export function ShellOverlay({
  open,
  onClose,
  label,
  anchorRef,
  children,
  width = 320,
  align = 'start',
  modal = true,
  sheetOnDesktop = false,
  tall = false,
  keepMounted = false,
  restoreFocus = true,
  className,
}: {
  open: boolean;
  onClose(): void;
  label: string;
  /** The stable header button: anchors the popover and gets focus back. */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  width?: number;
  align?: 'start' | 'end';
  /** Inert background and scroll lock. Menus use false. */
  modal?: boolean;
  /** Present as a sheet at any width (the compact finder band). */
  sheetOnDesktop?: boolean;
  /** A sheet that fills most of the screen, for content that scrolls inside (the finder list). */
  tall?: boolean;
  keepMounted?: boolean;
  /** False when the caller moves focus elsewhere on purpose (a full-screen dialog follows). */
  restoreFocus?: boolean;
  className?: string;
}) {
  const phone = useMedia(phoneQuery);
  const sheet = phone || sheetOnDesktop;
  const panel = useRef<HTMLDivElement>(null);
  useWorkspaceShortcutOwner(panel, open);
  const [id] = useState(() => Symbol(label));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;
  const [style, setStyle] = useState<CSSProperties>({});

  // One overlay at a time.
  useEffect(() => {
    if (!open) return;
    useActiveOverlay.setState({ active: id });
    return useActiveOverlay.subscribe((state) => {
      if (state.active !== id) closeRef.current();
    });
  }, [open, id]);
  useEffect(
    () => () => {
      if (useActiveOverlay.getState().active === id) useActiveOverlay.setState({ active: null });
    },
    [id],
  );

  const reposition = useCallback(() => {
    if (sheet) setStyle({});
    else setStyle(place(anchorRef.current, width, align));
  }, [anchorRef, sheet, width, align]);
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [open, reposition]);

  // Inert/scroll lock and outside press.
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.getElementById('shell-root');
    const previousOverflow = document.body.style.overflow;
    const previousInert = root?.getAttribute('inert') ?? null;
    if (modal) {
      root?.setAttribute('inert', '');
      if (sheet) document.body.style.overflow = 'hidden';
    }
    const outside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (document.querySelector('dialog[open]')) return;
      closeRef.current();
    };
    document.addEventListener('mousedown', outside, true);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      if (modal) {
        // Put back exactly what was there: another owner may have made the shell inert first.
        if (previousInert === null) root?.removeAttribute('inert');
        else root?.setAttribute('inert', previousInert);
        document.body.style.overflow = previousOverflow;
      }
    };
  }, [open, modal, sheet, anchorRef]);

  // Focus moves in after the commit, not during it: React restores the previously focused
  // element at the end of a commit, which would pull focus back out to the header button.
  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
    (first ?? panel.current)?.focus({ preventScroll: true });
  }, [open]);

  // Focus goes back to the header button after the commit: a passive effect, so React's own
  // restoration of the previously focused element (the hidden panel of a kept-mounted sheet)
  // cannot undo it.
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    return () => {
      if (restoreRef.current && anchor?.isConnected && !anchor.closest('[inert]'))
        anchor.focus({ preventScroll: true });
    };
  }, [open, anchorRef]);

  const keydown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      // A native dialog above the overlay owns Escape.
      if (document.querySelector('dialog[open]')) return;
      // An open combobox inside closes its own list first.
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('[role="combobox"][aria-expanded="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    if (document.querySelector('dialog[open]')) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter(
      (element) => !element.closest('[hidden], [inert]'),
    );
    const firstItem = items[0];
    const lastItem = items.at(-1);
    if (!firstItem || !lastItem) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (!modal) {
      // A menu closes when Tab leaves it; the header button keeps focus order natural.
      if ((event.shiftKey && active === firstItem) || (!event.shiftKey && active === lastItem)) {
        onClose();
      }
      return;
    }
    if (event.shiftKey && (active === firstItem || active === panel.current)) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && active === lastItem) {
      event.preventDefault();
      firstItem.focus();
    } else if (!panel.current.contains(active)) {
      event.preventDefault();
      firstItem.focus();
    }
  };

  if (!open && !keepMounted) return null;
  return createPortal(
    <div
      className={styles.layer}
      data-sheet={sheet || undefined}
      data-open={open}
      hidden={!open}
      data-shell-overlay={open ? label : undefined}
    >
      {sheet && open && <div className={styles.scrim} aria-hidden="true" />}
      <div
        ref={panel}
        className={[styles.panel, tall && styles.tall, className].filter(Boolean).join(' ')}
        style={sheet ? undefined : style}
        role={modal ? 'dialog' : 'group'}
        aria-modal={modal && open ? 'true' : undefined}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={keydown}
      >
        {sheet && (
          <header className={styles.sheetHeader}>
            <strong>{label}</strong>
            <button type="button" onClick={onClose} aria-label={`Close ${label}`}>
              Close
            </button>
          </header>
        )}
        <div className={styles.content}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
