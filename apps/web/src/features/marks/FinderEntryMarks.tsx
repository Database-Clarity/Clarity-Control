import { MarksControl } from './MarksControl';
import styles from './marks.module.scss';

/** A row action only: custom marks never roll up to category or group pickers. */
export function FinderEntryMarks({ hash }: { hash: number }) {
  return (
    <span
      data-entry-marks
      className={styles.finderAction}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MarksControl hash={hash} iconOnly />
    </span>
  );
}
export const markPopupOwnsFocus = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[data-entry-marks-popup]');
