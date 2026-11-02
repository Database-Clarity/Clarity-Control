import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../stores/settings';
import { useSettingsPanel } from './panel';
import { SettingsContent } from './SettingsContent';
import styles from './SettingsPopover.module.scss';

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const phone = '(max-width: 700px)';
const width = 480;
const margin = 8;

/** Fixed position beside the opening button: right of it when there is room, else under it. */
function anchor(button: Element | null): CSSProperties {
  if (!button || window.matchMedia?.(phone).matches) return {};
  const rect = button.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.right + margin, window.innerWidth - width - margin));
  const fromBottom = rect.top > window.innerHeight / 2;
  return fromBottom
    ? {
        left,
        bottom: Math.max(margin, window.innerHeight - rect.bottom),
        maxHeight: rect.bottom - margin,
      }
    : { left, top: Math.max(margin, rect.top), maxHeight: window.innerHeight - rect.top - margin };
}

/** Mounted only while open: mounting enters Settings, unmounting leaves it (and syncs once). */
export function SettingsPopover({ layout }: { layout: React.RefObject<HTMLElement | null> }) {
  const open = useSettingsPanel((state) => state.open);
  return open ? <OpenSettings layout={layout} /> : null;
}

function OpenSettings({ layout }: { layout: React.RefObject<HTMLElement | null> }) {
  const panel = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const [style] = useState(() =>
    anchor(opener ?? document.querySelector('.settings-link, button.settings-link')),
  );
  const close = () => useSettingsPanel.getState().hide();
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
          : document.querySelector<HTMLElement>('.settings-link');
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
