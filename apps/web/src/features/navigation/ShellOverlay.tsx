import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { scaledPx } from '../../ui/scale';
import {
  applyPlacement,
  followPlacement,
  naturalHeight,
  placeAnchored,
  visibleArea,
} from '../../ui/anchorPlacement';
import { create } from 'zustand';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './ShellOverlay.module.scss';
import { useWorkspaceShortcutOwner } from '../../ui/interaction';

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The phone finder's most height (CSS px at UI 100; it scales): the controls, the field, and
 * about 15 compact rows. A shorter screen or the keyboard shrinks it to the room there is.
 */
const FINDER_CAP = 560;

/** Only one shell overlay is open at a time: opening another closes the one before it. */
const useActiveOverlay = create<{ active: symbol | null }>(() => ({ active: null }));

/**
 * Header popovers share one primitive. On every screen size it is a popover anchored by its header
 * button (below it, or above when that fits better; on a phone up to the page width less the edge
 * inset, clear of the keyboard; see ui/anchorPlacement.ts). The tall finder on a phone hangs from the
 * header's lower edge, right under its trigger, at the page width, and reaches down to the keyboard
 * or the screen edge (its list scrolls inside). Opening moves focus in; Tab stays inside;
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
  /**
   * Content that scrolls inside and fills the room (the finder list). On a phone it hangs from the
   * lower edge of the header that holds its trigger, at the page width, down to the keyboard or the
   * screen edge.
   */
  tall?: boolean;
  keepMounted?: boolean;
  /** False when the caller moves focus elsewhere on purpose (a full-screen dialog follows). */
  restoreFocus?: boolean;
  className?: string;
}) {
  const phone = useMedia(phoneQuery);
  /** The phone finder: anchored like the rest, but it fills its side and locks the page. */
  const fill = phone && tall;
  const panel = useRef<HTMLDivElement>(null);
  useWorkspaceShortcutOwner(panel, open);
  const [id] = useState(() => Symbol(label));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;

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
    const element = panel.current;
    if (!element) return;
    const anchor = anchorRef.current;
    const area = visibleArea(window);
    if (!anchor) {
      Object.assign(element.style, { top: '40px', left: `${area.edge}px`, width: `${width}px` });
      return;
    }
    if (fill) {
      // Hang from the header's lower edge (a row boundary), not the title button's, at the page
      // width; the height is the whole room, so the controls stay on top and the list shrinks
      // when the keyboard opens.
      const header = anchor.closest('header') ?? anchor;
      const placed = placeAnchored({
        trigger: header.getBoundingClientRect(),
        area,
        width: area.width,
        gap: 0,
      });
      // Capped on a tall phone so it reads as a popover from the header, not a full-screen page;
      // the list scrolls inside it either way.
      const height = Math.min(placed.maxHeight, scaledPx(FINDER_CAP));
      applyPlacement(element, { ...placed, maxHeight: height });
      element.style.height = `${height}px`;
      return;
    }
    element.style.height = '';
    const input = {
      trigger: anchor.getBoundingClientRect(),
      area,
      width: scaledPx(width),
      align,
      desktop: !phone,
    };
    // Below first, at the final width, so the content's height is measured as it will wrap.
    const below = placeAnchored(input);
    applyPlacement(element, below);
    if (!phone) return;
    const height = naturalHeight(element, element.querySelector<HTMLElement>(`.${styles.content}`));
    if (height > below.maxHeight) applyPlacement(element, placeAnchored({ ...input, height }));
  }, [anchorRef, fill, phone, width, align]);
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    return followPlacement(() => panel.current, reposition);
  }, [open, reposition]);

  // Inert/scroll lock and outside press.
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.getElementById('shell-root');
    const previousOverflow = document.body.style.overflow;
    const previousInert = root?.getAttribute('inert') ?? null;
    if (modal) {
      root?.setAttribute('inert', '');
      if (fill) document.body.style.overflow = 'hidden';
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
  }, [open, modal, fill, anchorRef]);

  // Focus moves in after the commit, not during it: React restores the previously focused
  // element at the end of a commit, which would pull focus back out to the header button.
  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
    (first ?? panel.current)?.focus({ preventScroll: true });
  }, [open]);

  // Focus goes back to the header button after the commit: a passive effect, so React's own
  // restoration of the previously focused element (the hidden panel of a kept-mounted overlay)
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
      data-open={open}
      hidden={!open}
      data-shell-overlay={open ? label : undefined}
    >
      <div
        ref={panel}
        className={[styles.panel, tall && styles.tall, className].filter(Boolean).join(' ')}
        role={modal ? 'dialog' : 'group'}
        aria-modal={modal && open ? 'true' : undefined}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={keydown}
      >
        <div className={styles.content}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
