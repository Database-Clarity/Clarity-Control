import { createContext, useContext, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import styles from './RightPane.module.scss';

/**
 * The editor page's right pane (Compendium, English). A 28px header (title, then controls pushed
 * right; 44px where controls are touch-sized) above a body that scrolls on its own, so the header
 * stays put. Flexible text in the header ellipsises; controls never wrap.
 */
export function RightPane({
  label,
  header,
  children,
  bodyRef,
  className,
  busy,
}: {
  label: string;
  header: ReactNode;
  children: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  className?: string;
  busy?: boolean;
}) {
  return (
    <aside
      className={className ? `${styles.pane} ${className}` : styles.pane}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      {header}
      <div className={styles.body} ref={bodyRef}>
        {children}
      </div>
    </aside>
  );
}

/**
 * Panes that share the right pane, one at a time: whoever lays the panes out provides this, and
 * each pane's header then shows the tabs where its title would be (no second header row).
 */
export interface RightPaneTabs {
  label: string;
  tabs: readonly { id: string; label: string }[];
  active: string;
  onSelect(id: string): void;
}
export const RightPaneTabsContext = createContext<RightPaneTabs | null>(null);

export function RightPaneHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const tabs = useContext(RightPaneTabsContext);
  return (
    <div className={styles.header} role="group" aria-label={`${String(title)} tools`}>
      {tabs ? (
        <>
          <h3 className="sr-only">{title}</h3>
          <PaneTabs {...tabs} />
        </>
      ) : (
        <h3 className={styles.title}>{title}</h3>
      )}
      {children && <span className={styles.controls}>{children}</span>}
    </div>
  );
}

/** One tab stop; Left, Right, Home, and End pick a tab. The new pane's header takes the focus. */
function PaneTabs({ label, tabs, active, onSelect }: RightPaneTabs) {
  const onKeyDown = (event: KeyboardEvent) => {
    const at = tabs.findIndex((tab) => tab.id === active);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    onSelect(tabs[to]!.id);
  };
  return (
    <span className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          data-pane-tab={tab.id}
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </span>
  );
}

/** Two or more exclusive choices as one segmented control (aria-pressed buttons). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <span className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled || undefined}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
