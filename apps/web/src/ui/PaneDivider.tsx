import type { PaneDividerHandle } from './usePaneDivider';
import styles from './PaneDivider.module.scss';

type Props = PaneDividerHandle['divider'] & {
  /** What the handle resizes, e.g. "Resize editor and Compendium". */
  label: string;
  /** Grid placement from the page; the look is owned here. */
  className?: string;
  /** Id of the pane the handle sizes, so assistive technology can name it. */
  controls?: string;
};

/**
 * The one resize handle for every pair of panes. The element is the 16px hit zone; the line and the
 * quiet pill are drawn inside it, so the track never changes size and nothing around it moves.
 */
export function PaneDivider({
  value,
  min,
  max,
  collapsed,
  collapsible,
  dragging,
  label,
  className,
  controls,
  ...handlers
}: Props) {
  return (
    <div
      className={`${styles.divider}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-expanded={collapsible ? !collapsed : undefined}
      data-dragging={dragging || undefined}
      data-collapsed={collapsed || undefined}
      tabIndex={0}
      {...handlers}
    />
  );
}
