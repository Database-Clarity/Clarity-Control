import { MarksControl } from './MarksControl';
import { useState } from 'react';
import { apiUrl } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { noEntryMarks, useMarksStore } from './store';
import styles from './marks.module.scss';

/** A row action only: custom marks never roll up to category or group pickers. */
export function FinderEntryMarks({ hash }: { hash: number }) {
  const entries = useMarksStore((state) => state.index.get(hash) ?? noEntryMarks);
  const error = useMarksStore((state) => !!state.error);
  const user = useAuthStore((state) => state.user);
  const allowed = !!apiUrl && (user?.role === 'maintainer' || user?.role === 'editor');
  const [activated, setActivated] = useState<{ hash: number; user: typeof user }>();
  if (!allowed && !entries.length && !error) return null;
  return (
    <span
      data-entry-marks
      className={styles.finderAction}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {activated?.hash === hash && activated.user === user ? (
        <MarksControl hash={hash} iconOnly initiallyOpen />
      ) : (
        <button
          type="button"
          aria-label="Entry marks"
          aria-haspopup="dialog"
          aria-expanded={false}
          onClick={() => setActivated({ hash, user })}
        >
          <span aria-hidden="true" data-marked={!!entries.length}>
            ⚑
          </span>
        </button>
      )}
    </span>
  );
}
export const markPopupOwnsFocus = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[data-entry-marks-popup]');
