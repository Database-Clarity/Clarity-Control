import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
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

const tabsWidths = new Map<string, number>();
let lastTabsWidth: number | undefined;

/**
 * Width in CSS pixels of the pane tabs shown in this pane's header in place of its title, 0 when
 * there are none. A pane whose header holds optional controls uses it to know how much room the
 * tabs take. `bodyRef` is the pane body; the header is the element just before it. Widths are
 * remembered per label set, and a new label set (another report count) starts from the last
 * measured width until its observer reports, so stepping never forces a layout; only the first
 * pane of a session measures before paint.
 */
export function usePaneTabsWidth(bodyRef: RefObject<HTMLElement | null>): number {
  const tabs = useContext(RightPaneTabsContext);
  const key = tabs ? tabs.tabs.map((tab) => tab.label).join('|') : '';
  const [width, setWidth] = useState(() => (key ? (tabsWidths.get(key) ?? lastTabsWidth ?? 0) : 0));
  useLayoutEffect(() => {
    const list = key
      ? bodyRef.current?.previousElementSibling?.querySelector<HTMLElement>('[role="tablist"]')
      : null;
    if (!list) {
      setWidth(0);
      return;
    }
    const remember = (next: number) => {
      tabsWidths.set(key, next);
      lastTabsWidth = next;
      setWidth(next);
    };
    const known = tabsWidths.get(key) ?? lastTabsWidth;
    if (known === undefined || typeof ResizeObserver === 'undefined')
      remember(list.getBoundingClientRect().width);
    else setWidth(known);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0]?.inlineSize;
      if (next) remember(next);
    });
    observer.observe(list, { box: 'border-box' });
    return () => observer.disconnect();
  }, [bodyRef, key]);
  return width;
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
