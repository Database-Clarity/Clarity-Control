import { useRef } from 'react';
import { useSettingsPanel } from '../settings/panel';
import styles from './SettingsButton.module.scss';

/**
 * The header's Settings gear. It is the stable anchor Settings opens from and where focus returns
 * on close (Escape, close button, Back), so it stays mounted whether or not the panel is open.
 */
export function SettingsButton() {
  const button = useRef<HTMLButtonElement>(null);
  const open = useSettingsPanel((state) => state.open);
  return (
    <button
      ref={button}
      type="button"
      className={styles.button}
      data-settings-button
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Settings"
      title="Settings"
      onClick={() => {
        if (open) useSettingsPanel.getState().hide();
        else useSettingsPanel.getState().show(button.current);
      }}
    >
      <GearIcon className={styles.icon} />
    </button>
  );
}

/** The Settings gear, shared by the header button and the phone's Clarity menu row. */
export function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className={className}>
      <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.66-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
    </svg>
  );
}
