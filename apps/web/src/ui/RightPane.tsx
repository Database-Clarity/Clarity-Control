import type { ReactNode, Ref } from 'react';
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

export function RightPaneHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.header} role="group" aria-label={`${String(title)} tools`}>
      <h3 className={styles.title}>{title}</h3>
      {children && <span className={styles.controls}>{children}</span>}
    </div>
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
