import { languageLabel } from '../../languageLabels';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { apiUrl, loginUrl, rememberSignIn, subscribeSession } from '../../services/api';
import { rememberReturnPath } from '../../services/returnPath';
import { useAuthStore } from '../../stores/auth';

/**
 * Loads the login status once and follows session changes from other tabs. Mounted once by the
 * shell (the identity button), never by the menu that shows the result.
 */
export function useAuthSession() {
  const load = useAuthStore((state) => state.load);
  useEffect(() => {
    void load();
    return subscribeSession(() => {
      void load();
    });
  }, [load]);
}

/** What the identity button shows: short, one line, never wider than a name. */
export function identitySummary(state: {
  user: { login: string; role: string | null } | null;
  loading: boolean;
  error: string | null;
}): { label: string; detail: string; tone: 'ok' | 'wait' | 'error' | 'out' } {
  if (!apiUrl) return { label: 'Read-only', detail: 'Read-only: no login service', tone: 'out' };
  if (state.loading) return { label: 'Checking…', detail: 'Checking login', tone: 'wait' };
  if (state.error) return { label: 'Login problem', detail: 'Login unavailable', tone: 'error' };
  if (state.user)
    return {
      label: state.user.login,
      detail: `Signed in as ${state.user.login}, ${state.user.role ?? 'no editing role'}`,
      tone: 'ok',
    };
  return { label: 'Sign in', detail: 'Signed out, read-only', tone: 'out' };
}

/**
 * The identity states as menu content: who is signed in (role, languages, read-only reasons),
 * then sign-out; signed out, the GitHub sign-in as the
 * primary row with its "keep me signed in" choice; a login problem with its retry. Rows are the
 * menu's buttons and links; the revision line is the menu's own.
 */
export function IdentityStatus({ onAction }: { onAction?: () => void }) {
  const { user, loading, error, load, logout } = useAuthStore();
  const location = useLocation();
  const [remember, setRemember] = useState(false);
  if (!apiUrl)
    return (
      <>
        <p role="status" data-note>
          Read-only: VITE_API_URL is not configured. Local drafts are kept.
        </p>
      </>
    );
  if (loading)
    return (
      <>
        <p role="status" data-note>
          Checking login…
        </p>
      </>
    );
  if (error)
    return (
      <>
        <div role="alert" data-note>
          <p>Login unavailable: {error}</p>
          <button type="button" onClick={() => void load()}>
            Retry login status
          </button>
        </div>
      </>
    );
  if (user)
    return (
      <>
        <div data-who>
          <p>
            <strong>{user.login}</strong> <span data-badge>{user.role ?? 'no editing role'}</span>
          </p>
          {!user.role && <p data-note>Read-only: ask a maintainer for an editing role.</p>}
          {user.role === 'translator' && (
            <p data-note>
              Editable languages: {user.languages?.map(languageLabel).join(', ') || 'none'}. Other
              fields are read-only.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            onAction?.();
            logout();
          }}
        >
          Sign out
        </button>
      </>
    );
  return (
    <>
      <p role="status" data-note>
        Read-only: sign in to edit.
      </p>
      <a
        href={loginUrl()}
        data-primary
        onClick={() => {
          rememberSignIn(remember);
          rememberReturnPath(location);
        }}
      >
        Sign in with GitHub
      </a>
      <label>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Keep me signed in on this device
      </label>
    </>
  );
}
