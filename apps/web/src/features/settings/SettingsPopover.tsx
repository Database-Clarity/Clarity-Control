import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigationType } from 'react-router-dom';
import { useSettingsStore } from '../../stores/settings';
import { useSettingsPanel } from './panel';
import { SettingsContent } from './SettingsContent';
import styles from './SettingsPopover.module.scss';

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const phone = '(max-width: 700px)';
const width = 480;
const margin = 8;
const gap = 6;
// Keep a visible bottom edge: never run the popover to the viewport edge.
const edge = 20;

/** Fixed position under (or, in the lower half of the screen, above) the opening button. */
function anchor(button: Element | null): CSSProperties {
  if (!button || window.matchMedia?.(phone).matches) return {};
  const rect = button.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  if (rect.top > window.innerHeight / 2)
    return {
      left,
      bottom: window.innerHeight - rect.top + gap,
      maxHeight: Math.max(240, rect.top - gap - edge),
    };
  return {
    left,
    top: rect.bottom + gap,
    maxHeight: Math.max(240, window.innerHeight - rect.bottom - gap - edge),
  };
}

/** Mounted only while open: mounting enters Settings, unmounting leaves it (and syncs once). */
export function SettingsPopover({ layout }: { layout: React.RefObject<HTMLElement | null> }) {
  const open = useSettingsPanel((state) => state.open);
  return open ? <OpenSettings layout={layout} /> : null;
}

function OpenSettings({ layout }: { layout: React.RefObject<HTMLElement | null> }) {
  const panel = useRef<HTMLDivElement>(null);
  // The stable header button that opened Settings wins; otherwise whatever had focus.
  const [opener] = useState(() => {
    const registered = useSettingsPanel.getState().opener;
    if (registered?.isConnected) return registered;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const [style] = useState(() =>
    anchor(opener ?? document.querySelector('.settings-link, button.settings-link')),
  );
  const close = () => useSettingsPanel.getState().hide();
  // Back/Forward (or a hash change) moves the page behind a modal; close it instead of leaving a
  // stale, click-blocking popover. The /settings redirect itself is a REPLACE and stays open.
  const location = useLocation();
  const navigationType = useNavigationType();
  const openedAt = useRef(location.key);
  useEffect(() => {
    if (location.key !== openedAt.current && navigationType === 'POP')
      useSettingsPanel.getState().hide();
  }, [location.key, navigationType]);
  useEffect(() => {
    useSettingsStore.getState().enterSettings();
    return () => void useSettingsStore.getState().leaveSettings();
  }, []);
  useLayoutEffect(() => {
    const background = layout.current;
    background?.setAttribute('inert', '');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      background?.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      const target =
        opener?.isConnected && !opener.closest('[inert]')
          ? opener
          : document.querySelector<HTMLElement>('.settings-link, [data-identity-button]');
      (target ?? document.getElementById('main-content'))?.focus();
    };
  }, [layout, opener]);
  const keydown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // A native dialog above the popover owns Escape.
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!panel.current.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className={styles.popover}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={keydown}
      >
        <header className={styles.header}>
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={close} aria-label="Close settings">
            Close
          </button>
        </header>
        <div className={styles.body}>
          <SettingsContent />
        </div>
      </div>
    </div>,
    document.body,
  );
}
