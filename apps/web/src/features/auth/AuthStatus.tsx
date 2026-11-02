import { languageLabel } from '../../languageLabels';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { apiUrl, loginUrl } from '../../services/api';
import { rememberReturnPath } from '../../services/returnPath';
import { useAuthStore } from '../../stores/auth';
import { useSettingsPanel } from '../settings/panel';

export function AuthStatus() {
  return <AuthIdentity />;
}

const settingsLink = (
  <button
    type="button"
    className="settings-link"
    aria-haspopup="dialog"
    onClick={() => useSettingsPanel.getState().show()}
  >
    Settings
  </button>
);

function AuthIdentity() {
  const { user, loading, error, load, logout } = useAuthStore();
  const location = useLocation();
  useEffect(() => {
    void load();
  }, [load]);
  if (!apiUrl)
    return (
      <p role="status">
        Read-only: VITE_API_URL is not configured. Local drafts are preserved. {settingsLink}
      </p>
    );
  if (loading) return <p role="status">Checking login... {settingsLink}</p>;
  if (error)
    return (
      <p role="alert">
        Login unavailable: {error}{' '}
        <button type="button" onClick={() => void load()}>
          Retry login status
        </button>{' '}
        {settingsLink}
      </p>
    );
  if (user)
    return (
      <p>
        Signed in as {user.login} ({user.role ?? 'no editing role'}){' '}
        {!user.role && <span>Read-only: ask a maintainer for an editing role. </span>}
        {user.role === 'translator' && (
          <span>
            Editable languages: {user.languages?.map(languageLabel).join(', ') || 'none'}. Other
            fields are read-only.{' '}
          </span>
        )}
        <button type="button" onClick={logout}>
          Sign out
        </button>{' '}
        {settingsLink}
      </p>
    );
  return (
    <p role="status">
      Read-only: sign in to edit.{' '}
      <a href={loginUrl()} onClick={() => rememberReturnPath(location)}>
        Sign in with GitHub
      </a>{' '}
      {settingsLink}
    </p>
  );
}
