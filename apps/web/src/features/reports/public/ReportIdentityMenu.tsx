import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { identitySummary, useAuthSession } from '../../auth/AuthStatus';
import { useAuthStore } from '../../../stores/auth';
import { AccountPicture } from '../../navigation/AccountPicture';
import styles from '../../navigation/IdentityMenu.module.scss';

type Sheet = typeof import('./ReportIdentitySheet').default;
let loadedSheet: Sheet | undefined;
let sheetLoad: Promise<Sheet> | undefined;
/** The account sheet's code, fetched once; a failed fetch is tried again by the next use. */
function loadSheet(): Promise<Sheet> {
  sheetLoad ??= import('./ReportIdentitySheet').then(
    (module) => (loadedSheet = module.default),
    (error: unknown) => {
      sheetLoad = undefined;
      throw error;
    },
  );
  return sheetLoad;
}

export function ReportIdentityMenu() {
  useAuthSession();
  const { user, loading, error } = useAuthStore();
  /** The sheet loads on first hover, focus, or press, so a direct link's first paint has only the button. */
  const [Sheet, setSheet] = useState<Sheet | undefined>(() => loadedSheet);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** A failed press shows on the button (the next press retries); a failed prefetch stays quiet. */
  const load = (pressed: boolean) =>
    loadSheet().then(
      (sheet) => {
        if (!alive.current) return;
        setSheet(() => sheet);
        setFailed(false);
      },
      () => {
        if (!alive.current || !pressed) return;
        setFailed(true);
        setOpen(false);
      },
    );
  const prefetch = () => {
    if (!Sheet) void load(false);
  };
  // Pressed before the code arrived: Escape or a press elsewhere still dismisses it, so the sheet
  // never opens after the reporter has moved on.
  const pending = open && !Sheet;
  useEffect(() => {
    if (!pending) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const press = (event: MouseEvent | TouchEvent) => {
      if (!(event.target instanceof Node) || !button.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', press, true);
    document.addEventListener('touchstart', press, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', press, true);
      document.removeEventListener('touchstart', press, true);
    };
  }, [pending]);

  const summary = failed
    ? {
        label: 'Menu unavailable',
        detail: 'The account menu could not load. Press to try again.',
        tone: 'error' as const,
      }
    : identitySummary({ user, loading, error });
  const pictured = summary.tone === 'ok' && user;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.button}
        style={{ maxWidth: 'none' }}
        data-identity-button
        data-picture={pictured ? '' : undefined}
        data-tone={summary.tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={pending || undefined}
        aria-label={`Account: ${summary.detail}`}
        title={summary.detail}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => {
          if (!Sheet) {
            setFailed(false);
            void load(true);
          }
          setOpen((value) => !value);
        }}
      >
        {pictured ? (
          <AccountPicture id={user.id} login={user.login} />
        ) : (
          <span className={styles.label}>{summary.label}</span>
        )}
      </button>
      {Sheet && (
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={button}
          user={user}
          pictured={Boolean(pictured)}
        />
      )}
    </>
  );
}
