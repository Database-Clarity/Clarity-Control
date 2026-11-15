import { MarksControl } from './MarksControl';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { apiUrl } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { useMarksStore } from './store';
import styles from './marks.module.scss';

const FinderMarksContext = createContext<{
  index: ReturnType<typeof useMarksStore.getState>['index'];
  visible: boolean;
  open(hash: number, anchor: HTMLElement): void;
} | null>(null);

/** One subscription and menu host per open finder, rather than per row. */
export function FinderMarksProvider({ children }: { children: ReactNode }) {
  const index = useMarksStore((state) => state.index);
  const error = useMarksStore((state) => !!state.error);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const allowed = !!apiUrl && (user?.role === 'maintainer' || user?.role === 'editor');
  const [active, setActive] = useState<{
    hash: number;
    anchor: HTMLElement;
    user: typeof user;
    token: typeof token;
  }>();
  const open = useCallback((hash: number, anchor: HTMLElement) => {
    const { user, token } = useAuthStore.getState();
    setActive({ hash, anchor, user, token });
  }, []);
  const value = useMemo(
    () => ({ index, visible: allowed || error, open }),
    [index, allowed, error, open],
  );
  return (
    <FinderMarksContext.Provider value={value}>
      {children}
      {active && active.user === user && active.token === token && active.anchor.isConnected && (
        <MarksControl
          key={active.hash}
          hash={active.hash}
          anchorElement={active.anchor}
          initiallyOpen
          onClose={() => setActive(undefined)}
        />
      )}
    </FinderMarksContext.Provider>
  );
}

/** A pure row action: custom marks never roll up to category or group pickers. */
export function FinderEntryMarks({ hash }: { hash: number }) {
  const context = useContext(FinderMarksContext)!;
  const marked = !!context.index.get(hash)?.length;
  if (!context.visible && !marked) return null;
  return (
    <span
      data-entry-marks
      className={styles.finderAction}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Entry marks"
        aria-haspopup="dialog"
        aria-expanded={false}
        onClick={(event) => context.open(hash, event.currentTarget)}
      >
        <span aria-hidden="true" data-marked={marked}>
          ⚑
        </span>
      </button>
    </span>
  );
}
export const markPopupOwnsFocus = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[data-entry-marks-popup]');
